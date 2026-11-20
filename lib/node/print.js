import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fitPart } from '../printer.js';
import { orientMesh } from './stl.js';
import { shelfPack } from './threemf.js';

/** The source STL is printable when there are no separate print meshes. */
export function printSTLs(print) {
  const isSTL = (file) => typeof file === 'string' && /\.stl$/i.test(file);
  const files = print.pieces?.length ? print.pieces.map(({ file }) => file) : (print.files || []).filter(isSTL);
  return [...new Set(files.length ? files.filter(isSTL) : isSTL(print.source) ? [print.source] : [])];
}

export function resolveProjectPath(projectFile, path) {
  const dir = dirname(resolve(projectFile));
  return [resolve(path), resolve(dir, '..', path), resolve(dir, path)].find(existsSync) ?? null;
}

/** Match the calculated fit to an orientation that can be placed on the actual bed. */
export function preparePrintMesh(mesh, profile, placement, { nozzle, allowDiagonal } = {}) {
  const fit = fitPart(mesh.bbox.size, profile, { margin: placement.margin, nozzle, allowDiagonal });
  const { volume, ...packing } = placement;
  for (const option of fit.options) {
    const oriented = orientMesh(mesh, option);
    if (!shelfPack([{ size: oriented.bbox.size }], volume, packing).placed.length) continue;
    if (option !== fit.options[0]) {
      Object.assign(fit, option);
      fit.suggestion = `Fits with a ${oriented.bbox.size.map((value) => +value.toFixed(2)).join(' × ')} mm placement clear of the reserved bed areas.`;
    }
    return { fit, mesh: oriented };
  }
  if (fit.fits) {
    fit.fits = false;
    fit.suggestion = 'Does not fit the printable bed after margins and reserved areas.';
  }
  return { fit, mesh: null };
}
