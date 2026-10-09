import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPUTER_IMAGE, VERSION, isPublishedComputerImage, loadConfig } from '../src/config.js';

describe('computer image', () => {
  it('defaults to the published image for this version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(DEFAULT_COMPUTER_IMAGE).toBe(`ghcr.io/nastyrunner13/teambot-computer:${VERSION}`);
    const before = process.env.TEAMBOT_COMPUTER_IMAGE;
    delete process.env.TEAMBOT_COMPUTER_IMAGE;
    try {
      expect(loadConfig().computerImage).toBe(DEFAULT_COMPUTER_IMAGE);
    } finally {
      if (before !== undefined) process.env.TEAMBOT_COMPUTER_IMAGE = before;
    }
  });

  it('downloads only images TeamBot publishes', () => {
    expect(isPublishedComputerImage(DEFAULT_COMPUTER_IMAGE)).toBe(true);
    expect(isPublishedComputerImage('ghcr.io/nastyrunner13/teambot-computer@sha256:abc')).toBe(true);
    // Names TeamBot doesn't own could be anyone's.
    expect(isPublishedComputerImage('teambot/computer:latest')).toBe(false);
    expect(isPublishedComputerImage('ghcr.io/nastyrunner13/teambot-computer-evil:1.0.0')).toBe(false);
    expect(isPublishedComputerImage('ghcr.io/someone/teambot-computer:0.1.0')).toBe(false);
    expect(isPublishedComputerImage('evil.example/ghcr.io/nastyrunner13/teambot-computer:0.1.0')).toBe(false);
  });
});
