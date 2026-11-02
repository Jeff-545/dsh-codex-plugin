/**
 * Marketing metadata for the model slugs a ChatGPT plan serves.
 *
 * The plan model catalog (`GET /v1/models`) reports slugs only, so context
 * capacity, display names, input modalities, and reasoning choices have to be
 * declared here. The table is advisory: an unknown slug still routes (core
 * routing accepts unlisted ids), it just uses the conservative defaults below
 * so compaction runs early rather than after a rejected oversized request.
 *
 * @module dsh-chatgpt-plan/models
 */
import { MODEL_SUGGESTIONS } from './siwc.js'

/** Context capacity assumed for a slug this table does not describe. */
export const DEFAULT_CONTEXT_WINDOW = 272_000
/** Reasoning choices offered for a slug this table does not describe. */
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Known plan models. `contextWindow` matches the capacity the account's plan
 * currently advertises; `efforts` is the ordered subset the route accepts.
 */
export const KNOWN_MODELS = {
  'gpt-6.1-sol': {
    name: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  'gpt-6-astra': {
    name: 'GPT-6-Astra',
    description: 'Frontier intelligence for the most demanding work.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  'gpt-6.1-terra': {
    name: 'GPT-6.1 Terra',
    description: 'GPT-6.1 Terra Codex model.',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  'gpt-6-sol': {
    name: 'GPT-6-Sol',
    description: 'Previous generation workhorse model.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  'gpt-6-luna': {
    name: 'GPT-6-Luna',
    description: 'Fast and affordable model for easier tasks.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  'gpt-5.6-sol': {
    name: 'GPT-5.6-Sol',
    description: 'Older generation workhorse model.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6-Terra',
    description: 'Older balanced model for straightforward work.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  'gpt-5.6-luna': {
    name: 'GPT-5.6-Luna',
    description: 'Older fast and efficient model.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  'gpt-5.5': {
    name: 'GPT-5.5',
    description: 'Previous-generation general model.',
    contextWindow: 272_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
}

/**
 * Keep the default reasoning effort inside the advertised choices.
 * @param {string | undefined} preferred - the model's documented default.
 * @param {readonly string[]} efforts - the choices this route advertises.
 * @returns {string} an effort the model accepts.
 */
function pickDefaultEffort(preferred, efforts) {
  if (typeof preferred === 'string' && efforts.includes(preferred)) return preferred
  if (efforts.includes('medium')) return 'medium'
  return efforts[0]
}

/**
 * Describe one model slug for the harness catalog.
 * @param slug - the model id the route accepts.
 * @returns display metadata and capabilities for one model.
 */
export function modelInfo(slug, override) {
  const known = KNOWN_MODELS[slug] ?? {}
  return {
    id: slug,
    name: override?.name ?? known.name ?? slug,
    ...(override?.description ?? known.description) === undefined
      ? {}
      : { description: override?.description ?? known.description },
    contextWindow: override?.contextWindow ?? known.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    efforts: override?.efforts ?? known.efforts ?? DEFAULT_EFFORTS,
    defaultEffort: pickDefaultEffort(override?.defaultEffort ?? known.defaultEffort, override?.efforts ?? known.efforts ?? DEFAULT_EFFORTS),
    inputModalities: override?.inputModalities ?? ['text', 'image'],
  }
}

/**
 * The fallback catalog served before the plan catalog can be read.
 * @returns model slugs in display order.
 */
export function fallbackModels() {
  return [...MODEL_SUGGESTIONS]
}

/**
 * Merge a live plan catalog with the fallback suggestions.
 * @param entries - catalog entries read from the plan catalog, when available.
 * @returns ordered entries; the live catalog first, then unsurfaced fallbacks.
 */
export function orderCatalog(entries) {
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    if (typeof entry?.slug !== 'string' || entry.slug.length === 0 || seen.has(entry.slug)) continue
    seen.add(entry.slug)
    out.push(entry)
  }
  for (const slug of MODEL_SUGGESTIONS) {
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug })
  }
  return out
}
