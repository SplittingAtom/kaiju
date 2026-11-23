/**
 * Asks the workspace to show its Files panel (KOBE-819): the bell in the bar sits outside the
 * workspace's rail, so a Repo conversion notice's "Show in Files" goes through this event. The
 * workspace's rail answers by revealing the Files section, where the project's Repo row and its
 * Convert to repo… are. `projectId` names the project the notice is about.
 */
export interface ShowFilesRequest {
  readonly projectId: string;
}

export const SHOW_FILES_EVENT = "kobe:show-files";

export function requestShowFiles(request: ShowFilesRequest): void {
  window.dispatchEvent(new CustomEvent<ShowFilesRequest>(SHOW_FILES_EVENT, { detail: request }));
}

/** Calls `show` for every request; returns the unsubscribe. */
export function onShowFilesRequest(show: (request: ShowFilesRequest) => void): () => void {
  const on = (e: Event) => show((e as CustomEvent<ShowFilesRequest>).detail);
  window.addEventListener(SHOW_FILES_EVENT, on);
  return () => window.removeEventListener(SHOW_FILES_EVENT, on);
}
