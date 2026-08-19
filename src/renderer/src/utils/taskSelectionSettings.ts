export type PaneDirectoryTaskSelections = Record<string, Record<string, string>>

export function toPlainPaneDirectoryTaskSelections(
  selections: PaneDirectoryTaskSelections
): PaneDirectoryTaskSelections {
  return Object.fromEntries(
    Object.entries(selections).map(([paneId, directorySelections]) => [
      paneId,
      { ...directorySelections }
    ])
  )
}
