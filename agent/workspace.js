'use strict';
// Workspace confinement. Every path the model supplies goes through resolveInside().
const fs = require('fs');
const path = require('path');

class ToolError extends Error {}

function within(rootReal, p) {
  const rel = path.relative(rootReal, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Validate the workspace root chosen by the user and return its canonical path. */
function openWorkspace(root) {
  if (!root || typeof root !== 'string') throw new ToolError('No workspace folder selected');
  let real;
  try { real = fs.realpathSync(root); } catch { throw new ToolError('Workspace folder does not exist'); }
  if (!fs.statSync(real).isDirectory()) throw new ToolError('Workspace is not a folder');
  return real;
}

/**
 * Resolve a model-supplied, workspace-relative path.
 * Rejects absolute paths, "..", NUL bytes, and anything whose real location
 * (after following symlinks) is outside the workspace. Works for paths that do
 * not exist yet by checking the deepest existing ancestor.
 */
function resolveInside(rootReal, p = '.') {
  if (typeof p !== 'string') throw new ToolError('path must be a string');
  if (p === '') p = '.';
  if (p.includes('\0')) throw new ToolError('Invalid path');
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p) || /^~([\\/]|$)/.test(p))
    throw new ToolError('Absolute paths are not allowed; use a path relative to the workspace root');
  if (p.split(/[\\/]+/).includes('..')) throw new ToolError('".." is not allowed in paths');

  const abs = path.resolve(rootReal, p);
  if (!within(rootReal, abs)) throw new ToolError('Path escapes the workspace');

  let cur = abs;
  const tail = [];
  let real;
  for (;;) {
    try { real = fs.realpathSync(cur); break; }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new ToolError('Cannot resolve path');
      // A dangling symlink would let a "create" write through to its (outside) target.
      let isLink = false;
      try { isLink = fs.lstatSync(cur).isSymbolicLink(); } catch {}
      if (isLink) throw new ToolError('Refusing to follow a broken symlink');
      const parent = path.dirname(cur);
      if (parent === cur) throw new ToolError('Cannot resolve path');
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const full = path.join(real, ...tail);
  if (!within(rootReal, full)) throw new ToolError('Path escapes the workspace');
  const rel = (path.relative(rootReal, full) || '.').split(path.sep).join('/');
  return { abs: full, rel };
}

/** Writes into .git are refused: hooks/config there can execute code later. */
function isGitInternal(rel) {
  return rel.split('/').some(s => s.toLowerCase() === '.git');
}

module.exports = { ToolError, openWorkspace, resolveInside, within, isGitInternal };
