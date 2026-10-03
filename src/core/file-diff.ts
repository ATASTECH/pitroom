export interface FileDiffLine {
  id: string;
  type: 'added' | 'removed' | 'context' | 'hunk' | 'meta';
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface FileDiffData {
  path: string;
  status: string;
  lines: FileDiffLine[];
  additions?: number;
  deletions?: number;
  omittedLines: number;
  binary: boolean;
  incomplete: boolean;
  unavailable?: boolean;
}

const PREVIEW_LINES = 300;

function gitPath(value: string, prefix = true): string {
  let path = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes: number[] = [];
    const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' };
    for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
      if (match[1] && /^[0-7]+$/.test(match[1])) bytes.push(parseInt(match[1], 8));
      else bytes.push(...new TextEncoder().encode(match[2] ?? escapes[match[1]!] ?? match[1]!));
    }
    path = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return prefix ? path.replace(/^[ab]\//, '') : path;
}

function headerPath(header: string): string {
  const quoted = header.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return gitPath(quoted[2]!);
  return gitPath(header.slice(header.lastIndexOf(' b/') + 1));
}

export function fileDiffs(patch: string, changes: { path: string; status: string }[], sourceTruncated = false): FileDiffData[] {
  const files: FileDiffData[] = [];
  let file: FileDiffData | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  let row = 0;

  const finishHunk = () => {
    if (file && (oldLeft > 0 || newLeft > 0)) file.incomplete = true;
    oldLeft = newLeft = 0;
    inHunk = false;
  };
  const add = (line: Omit<FileDiffLine, 'id'>) => {
    if (!file) return;
    if (file.lines.length < PREVIEW_LINES) file.lines.push({ ...line, id: String(row) });
    else file.omittedLines++;
    row++;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finishHunk();
      file = { path: headerPath(line), status: 'M', lines: [], additions: 0, deletions: 0, omittedLines: 0, binary: false, incomplete: false };
      files.push(file);
      row = 0;
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1);
      newLeft = Number(hunk[4] ?? 1);
      inHunk = true;
      add({ type: 'hunk', content: line });
    } else if (inHunk && line.startsWith('\\ No newline at end of file')) {
      add({ type: 'meta', content: line });
    } else if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+') && newLeft > 0) {
        file.additions!++;
        newLeft--;
        add({ type: 'added', newLine: newLine++, content: line.slice(1) });
      } else if (line.startsWith('-') && oldLeft > 0) {
        file.deletions!++;
        oldLeft--;
        add({ type: 'removed', oldLine: oldLine++, content: line.slice(1) });
      } else if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        add({ type: 'context', oldLine: oldLine++, newLine: newLine++, content: line.slice(1) });
      } else {
        file.incomplete = true;
      }
    } else if (!inHunk) {
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = gitPath(line.slice(4).replace(/\t$/, ''));
      else if (line.startsWith('--- ') && line !== '--- /dev/null') file.path = gitPath(line.slice(4).replace(/\t$/, ''));
      else if (/^(GIT binary patch|Binary files .* differ)$/.test(line)) file.binary = true;
      else if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|similarity index) /.test(line)) {
        if (line.startsWith('new file mode ')) file.status = 'A';
        if (line.startsWith('deleted file mode ')) file.status = 'D';
        if (line.startsWith('rename to ')) { file.path = gitPath(line.slice(10), false); file.status = 'R'; }
        add({ type: 'meta', content: line });
      }
    }
  }
  finishHunk();
  if (sourceTruncated && file) file.incomplete = true;
  for (const f of files) {
    if (f.incomplete || f.binary) f.additions = f.deletions = undefined;
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const result = changes.map((change) => {
    const diff = byPath.get(change.path);
    byPath.delete(change.path);
    return diff ? { ...diff, status: change.status } : {
      ...change, lines: [], omittedLines: 0, binary: false, incomplete: sourceTruncated, unavailable: true,
    };
  });
  return [...result, ...byPath.values()];
}
