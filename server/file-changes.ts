/** The per-path file-change ledger shared by every session-detail reader. A path seen more than
 * once is merged: suffix-matched paths are one file, "added then modified" stays added, and known
 * line counts add up. */
export type FileStatus = "added" | "modified" | "deleted";
export type FileChange = {
  path: string;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
};

export function fileStatus(existing: FileStatus | undefined, next: FileStatus) {
  if (next === "deleted") return "deleted";
  if (existing === "added" && next === "modified") return "added";
  return next;
}

export function matchingFile(
  files: Map<string, FileChange>,
  path: string,
): [string, FileChange] | undefined {
  const exact = files.get(path);
  if (exact) return [path, exact];
  const normalizedPath = path.replaceAll("\\", "/");
  const suffixMatches = [...files.entries()].filter(([candidate]) => {
    const normalizedCandidate = candidate.replaceAll("\\", "/");
    return (
      normalizedPath.endsWith(`/${normalizedCandidate}`) ||
      normalizedCandidate.endsWith(`/${normalizedPath}`)
    );
  });
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

/** Counts stay null until a transcript shape exposes real patch lines. Once known, repeated edits
 * to the same path accumulate rather than letting a later metadata-only event erase them. */
export function upsertFile(
  files: Map<string, FileChange>,
  path: string,
  status: FileStatus,
  delta?: { additions: number; deletions: number },
) {
  const match = matchingFile(files, path);
  const existing = match?.[1];
  const displayPath =
    existing && existing.path.length > path.length ? existing.path : path;
  const next: FileChange = {
    path: displayPath,
    status: fileStatus(existing?.status, status),
    additions:
      delta === undefined
        ? (existing?.additions ?? null)
        : (existing?.additions ?? 0) + delta.additions,
    deletions:
      delta === undefined
        ? (existing?.deletions ?? null)
        : (existing?.deletions ?? 0) + delta.deletions,
  };
  if (match && match[0] !== displayPath) files.delete(match[0]);
  files.set(displayPath, next);
  return next;
}
