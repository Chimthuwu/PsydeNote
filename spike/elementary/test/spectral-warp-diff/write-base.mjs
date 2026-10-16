
    import { writeFileSync } from 'node:fs';
    import { getBaseWavetableFrames } from '../../dsp/wavetables.js';
    const ids = [0, 1, 0, 1, 0, 1, 0, 1];
    const bufs = ids.map((id, i) => getBaseWavetableFrames(id)[i % 8]);
    writeFileSync(process.argv[2], Buffer.concat(bufs.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))));
  