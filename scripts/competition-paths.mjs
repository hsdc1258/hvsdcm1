import fs from 'node:fs';
import path from 'node:path';

function realpath(file, fsImpl) {
  const resolver = fsImpl.realpathSync?.native || fsImpl.realpathSync;
  return typeof resolver === 'function' ? resolver(file) : file;
}

// Competition helpers can read credentials and overwrite evidence artifacts. Resolve
// existing junctions/symlinks and apply Windows' case-insensitive identity rules before
// comparing any input/output pair.
export function competitionPathIdentity(file, fsImpl = fs) {
  const resolved = path.resolve(file).normalize('NFC');
  let cursor = resolved;
  const suffix = [];
  while (true) {
    try {
      cursor = realpath(cursor, fsImpl);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  return path.join(cursor, ...suffix).normalize('NFC').toLowerCase();
}

export function requireCompetitionDistinctPaths(namedPaths, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const label = options.label || 'competition';
  const resolved = namedPaths.map(([name, file]) => [
    name,
    competitionPathIdentity(file, fsImpl),
  ]);
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (resolved[left][1] === resolved[right][1]) {
        throw new Error(`${label} ${resolved[left][0]} and ${resolved[right][0]} paths must differ`);
      }
    }
  }
}
