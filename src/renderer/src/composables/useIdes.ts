import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { IdeInfo } from '@shared/types'

const ides = ref<IdeInfo[]>([])
const loading = ref(false)
const paneIdeIds = ref<Record<string, string>>({})
let legacyDefaultIdeId: string | null = null
let initPromise: Promise<void> | null = null

async function load(force = false): Promise<IdeInfo[]> {
  loading.value = true
  try {
    const list = await window.api.ideList(force)
    ides.value = list
    return list
  } finally {
    loading.value = false
  }
}

function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const [settings] = await Promise.all([window.api.settingsGet(), load(false)])
    paneIdeIds.value = { ...(settings.paneSelectedIdeIds || {}) }
    legacyDefaultIdeId = typeof settings.defaultIde === 'string' ? settings.defaultIde : null
  })()
  return initPromise
}

function setSelected(paneId: string, id: string): void {
  if (paneIdeIds.value[paneId] === id) return
  const next = { ...paneIdeIds.value, [paneId]: id }
  paneIdeIds.value = next
  window.api.settingsSet({ paneSelectedIdeIds: next })
}

export function useIdes(paneId: string): {
  ides: Ref<IdeInfo[]>
  loading: Ref<boolean>
  selectedIde: ComputedRef<IdeInfo | null>
  init: () => Promise<void>
  load: (force?: boolean) => Promise<IdeInfo[]>
  setSelected: (id: string) => void
} {
  const selectedIde = computed<IdeInfo | null>(() => {
    if (!ides.value.length) return null
    const selectedId = paneIdeIds.value[paneId] ?? legacyDefaultIdeId
    return ides.value.find((item) => item.id === selectedId) ?? ides.value[0]
  })

  return {
    ides,
    loading,
    selectedIde,
    init,
    load,
    setSelected: (id: string) => setSelected(paneId, id)
  }
}
