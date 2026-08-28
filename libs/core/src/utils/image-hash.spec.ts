import { describe, it, expect } from 'vitest';
import {
  computeImageTag,
  parseBaseImage,
  parseCopySources,
  type ImageInputs,
} from './image-hash.js';

function inputs(overrides: Partial<ImageInputs> = {}): ImageInputs {
  return {
    dockerfile: 'FROM jives/hlds:cstrike\nCOPY apps/cs16/respawn-init.sh /x\n',
    baseDigest: 'sha256:aaaa',
    copiedFiles: { 'apps/cs16/respawn-init.sh': Buffer.from('#!/bin/sh\necho hi\n') },
    ...overrides,
  };
}

describe('parseBaseImage', () => {
  it('reads the FROM reference', () => {
    expect(parseBaseImage('FROM jives/hlds:cstrike\n')).toBe(
      'jives/hlds:cstrike',
    );
  });

  it('ignores --platform flags', () => {
    expect(parseBaseImage('FROM --platform=linux/amd64 alpine:3.21\n')).toBe(
      'alpine:3.21',
    );
  });

  it('skips comments above the FROM', () => {
    expect(parseBaseImage('# a comment\n\nFROM alpine:3.21\n')).toBe(
      'alpine:3.21',
    );
  });

  it('throws when there is no FROM', () => {
    expect(() => parseBaseImage('RUN true\n')).toThrow(/no FROM/);
  });
});

describe('parseCopySources', () => {
  it('captures the source operand, not the destination', () => {
    expect(
      parseCopySources('FROM x\nCOPY apps/cs16/respawn-init.sh /respawn-init.sh\n'),
    ).toEqual(['apps/cs16/respawn-init.sh']);
  });

  it('captures multiple sources', () => {
    expect(parseCopySources('FROM x\nCOPY a.sh b.sh /dst/\n')).toEqual([
      'a.sh',
      'b.sh',
    ]);
  });

  it('ignores COPY --from=stage (bytes come from another stage)', () => {
    expect(parseCopySources('FROM x\nCOPY --from=build /out /out\n')).toEqual([]);
  });

  it('handles a Dockerfile with no COPY', () => {
    expect(parseCopySources('FROM jives/hlds:tfc\n')).toEqual([]);
  });
});

describe('computeImageTag', () => {
  it('is stable for identical inputs', () => {
    expect(computeImageTag(inputs())).toBe(computeImageTag(inputs()));
  });

  it('looks like sha-<12 hex>', () => {
    expect(computeImageTag(inputs())).toMatch(/^sha-[0-9a-f]{12}$/);
  });

  it('changes when the base image digest moves', () => {
    // Upstream republishing `jives/hlds:cstrike` must force a rebuild, even
    // though our Dockerfile is byte-identical.
    expect(computeImageTag(inputs({ baseDigest: 'sha256:bbbb' }))).not.toBe(
      computeImageTag(inputs()),
    );
  });

  it('changes when the Dockerfile changes', () => {
    expect(
      computeImageTag(inputs({ dockerfile: 'FROM jives/hlds:cstrike\n' })),
    ).not.toBe(computeImageTag(inputs()));
  });

  it('changes when a COPYed file changes', () => {
    // The uncommitted-shim-edit case: a git SHA would not notice this.
    expect(
      computeImageTag(
        inputs({ copiedFiles: { 'apps/cs16/respawn-init.sh': Buffer.from('different') } }),
      ),
    ).not.toBe(computeImageTag(inputs()));
  });

  it('does not depend on file enumeration order', () => {
    const a = computeImageTag(inputs({ copiedFiles: { a: Buffer.from('1'), b: Buffer.from('2') } }));
    const b = computeImageTag(inputs({ copiedFiles: { b: Buffer.from('2'), a: Buffer.from('1') } }));
    expect(a).toBe(b);
  });

  it('distinguishes content moved between files', () => {
    const a = computeImageTag(inputs({ copiedFiles: { a: Buffer.from('x'), b: Buffer.alloc(0) } }));
    const b = computeImageTag(inputs({ copiedFiles: { a: Buffer.alloc(0), b: Buffer.from('x') } }));
    expect(a).not.toBe(b);
  });

  // Two DIFFERENT binaries whose bytes are both invalid UTF-8. Read as strings they
  // both decode to U+FFFD and collide; read as bytes they must not. This is why
  // copiedFiles is Buffer — services now COPY 49 MB of .bsp/.wad game content.
  it('distinguishes binary files that decode to the same UTF-8 replacement chars', () => {
    const a = computeImageTag(inputs({ copiedFiles: { m: Buffer.from([0xff, 0xfe]) } }));
    const b = computeImageTag(inputs({ copiedFiles: { m: Buffer.from([0xff, 0xfd]) } }));
    expect(a).not.toBe(b);
    // Guard the premise: these really are indistinguishable once decoded.
    expect(Buffer.from([0xff, 0xfe]).toString('utf-8')).toBe(
      Buffer.from([0xff, 0xfd]).toString('utf-8'),
    );
  });
});
