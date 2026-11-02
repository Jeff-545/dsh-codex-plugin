/**
 * The `chatgpt-plan` LLM adapter.
 *
 * One route served by the ChatGPT plan-usage access token: the harness model
 * catalog is built from {@link ChatGptPlanAdapter.listModels}, and each call is
 * a streamed Responses API request under the plan-usage constraints.
 *
 * @module dsh-chatgpt-plan/adapter
 */
import { fetchPlanCatalog } from './siwc.js'
import { KNOWN_MODELS, modelInfo, orderCatalog } from './models.js'
import { PlanError, ensureAccessToken, readCredential, refreshNow } from './store.js'
import { PlanProtocolError, buildRequestBody, planStream } from './responses.js'

/** How long one live model-catalog read is reused. */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Resolve request images into base64 payloads for the wire body.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} options - the harness generate options.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<Map<string, { mediaType: string, data: string }>>} request images by attachment id.
 */
async function resolveImages(ctx, options, signal) {
  const blocks = (options.messages ?? []).flatMap(message =>
    (message.role === 'user' || message.role === 'tool' ? message.content ?? [] : [])
      .filter(block => block?.type === 'image'))
  if (blocks.length === 0) return new Map()
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new PlanError('NO_ATTACHMENT_STORE', 'chatgpt-plan: this composition mounts no attachment store, so request images cannot be read.')
  }
  const images = new Map()
  for (const block of blocks) {
    const attachment = block.attachment
    if (attachment === undefined || images.has(attachment.attachmentId)) continue
    const version = await attachments.readImageRequest(
      attachment,
      { width: attachment.width, height: attachment.height, maxBytes: attachment.bytes },
      signal,
    )
    images.set(attachment.attachmentId, {
      mediaType: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
    })
  }
  return images
}

/**
 * Translate a thrown value into a neutral finish failure.
 * @param {unknown} error - the thrown value.
 * @returns {{ code: string, message: string, status?: number, providerRetryAfterMs?: number }} the failure.
 */
function toFailure(error) {
  if (error instanceof PlanProtocolError) return error.failure
  if (error instanceof PlanError) return { code: error.code, message: error.message }
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'PROVIDER_ERROR'
  return { code, message }
}

/**
 * The adapter for one `chatgpt-plan`-style provider route.
 */
export class ChatGptPlanAdapter {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM and credential seams.
   * @param {{ provider: string, displayName: string }} route - route identity this adapter serves.
   */
  constructor(ctx, route) {
    this.ctx = ctx
    this.route = route
    this.cachedCatalog = { at: 0, entries: [] }
  }

  /**
   * Describe the route for selector surfaces.
   * @param {string} provider - the registered route name.
   * @returns {{ id: string, name: string }} detached provider metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: this.route.displayName }
  }

  /**
   * Use the harness default retry policy for this route.
   * @returns {undefined} undefined, so the registry materializes its normal defaults.
   */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Declare no provider-side image pricing; the token meter uses its neutral estimate.
   * @returns {undefined} always undefined.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Preserve normalized request images.
   * @param {string} provider - the registered route name.
   * @param {string} model - the exact model id.
   * @param {object} image - the normalized image attachment.
   * @returns {{ width: number, height: number, maxBytes: number }} the request target.
   */
  imageRequestTarget(provider, model, image) {
    void provider
    void model
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * Bind exact model metadata to this adapter generation for one call.
   * @param {string} provider - the registered route name.
   * @param {string} model - the exact model id.
   * @param {AbortSignal} [signal] - cancellation for model resolution.
   * @returns {Promise<{ model: object, stream: (options: object) => AsyncIterable<object> }>} the prepared call.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Advertise the models the plan serves.
   *
   * The plan catalog is authoritative when it can be read with a stored
   * sign-in; otherwise the bundled fallback keeps the route selectable so the
   * user can connect first and pick a model after signing in.
   * @param {string} provider - the registered route name.
   * @returns {Promise<readonly object[]>} model metadata for the catalog.
   */
  async listModels(provider) {
    const entries = await this.currentCatalog()
    return entries.map(entry => {
      const info = modelInfo(entry.slug, entry)
      return {
        provider,
        id: info.id,
        name: info.name,
        ...info.description === undefined ? {} : { description: info.description },
        inputModalities: info.inputModalities,
      }
    })
  }

  /**
   * Read the plan's model catalog, caching one successful read.
   * @returns {Promise<object[]>} ordered catalog entries with display metadata.
   */
  async currentCatalog() {
    const now = Date.now()
    if (this.cachedCatalog.entries.length > 0 && now - this.cachedCatalog.at < MODEL_CACHE_TTL_MS) {
      return this.cachedCatalog.entries
    }
    const credential = await readCredential(this.ctx).catch(() => undefined)
    if (credential !== undefined && credential.planEnabled === true) {
      try {
        const { accessToken } = await ensureAccessToken(this.ctx, undefined)
        const live = await fetchPlanCatalog(accessToken, { signal: AbortSignal.timeout(15_000) })
        if (live.length > 0) {
          this.cachedCatalog = { at: now, entries: orderCatalog(live) }
          return this.cachedCatalog.entries
        }
      } catch {
        // Catalog reads are advisory: a transient failure must not hide the
        // route, so the fallback list below serves the picker instead.
      }
    }
    return orderCatalog([])
  }

  /**
   * Resolve one model's capabilities without provider I/O.
   * @param {string} provider - the registered route name.
   * @param {string} model - the exact model id.
   * @returns {Promise<object>} catalog and reasoning metadata.
   */
  resolveModel(provider, model) {
    const entry = this.cachedCatalog.entries.find(candidate => candidate.slug === model)
    const info = modelInfo(model, entry)
    return Promise.resolve({
      provider,
      id: model,
      name: info.name,
      ...info.description === undefined ? {} : { description: info.description },
      context: { contextWindow: info.contextWindow },
      inputModalities: info.inputModalities,
      reasoning: {
        efforts: info.efforts.map(effort => ({ id: effort, name: effort })),
        defaultEffort: info.defaultEffort,
      },
    })
  }

  /**
   * Stream one plan-usage model call.
   *
   * The stream always settles with exactly one terminal finish chunk: success,
   * a provider refusal, or cancellation.
   * @param {object} options - the assembled harness request.
   * @yields {object} harness stream chunks.
   */
  async *stream(options) {
    const signal = options.signal
    try {
      const images = await resolveImages(this.ctx, options, signal)
      const body = buildRequestBody(options, images)
      let accessToken
      try {
        ({ accessToken } = await ensureAccessToken(this.ctx, signal))
      } catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: toFailure(error) } }
        return
      }
      try {
        yield* planStream({ accessToken, body, signal })
        return
      } catch (error) {
        if (error instanceof PlanProtocolError && error.failure.status === 401) {
          const refreshed = await refreshNow(this.ctx, signal)
          yield* planStream({ accessToken: refreshed.accessToken, body, signal })
          return
        }
        throw error
      }
    } catch (error) {
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'chatgpt-plan: the request was cancelled' } } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: toFailure(error) } }
    }
  }
}

/** Slug-to-name helper shared with the settings surface. */
export { KNOWN_MODELS }
