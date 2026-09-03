import { describe, expect, it, vi } from 'vitest';
import {
  closeTelegramPopup,
  handleTelegramLinkFailure,
  handleTelegramLinkResponse,
  isValidTelegramDeepLink,
  openTelegramDeepLink,
} from '../public/telegram-link.js';

function createPopup() {
  const popup = {
    closed: false,
    close: vi.fn(function close(this: { closed: boolean }) {
      this.closed = true;
    }),
    location: {
      href: '',
    },
  };

  return popup;
}

describe('telegram link popup helpers', () => {
  it('accepts only safe HTTPS Telegram deep links', () => {
    expect(isValidTelegramDeepLink('https://t.me/TalliMCP_bot?start=link_123')).toBe(true);
    expect(isValidTelegramDeepLink('https://telegram.me/TalliMCP_bot?start=link_123')).toBe(true);
    expect(isValidTelegramDeepLink('http://t.me/TalliMCP_bot?start=link_123')).toBe(false);
    expect(isValidTelegramDeepLink('https://example.com')).toBe(false);
    expect(isValidTelegramDeepLink('')).toBe(false);
  });

  it('navigates a popup only for a validated Telegram deep link', () => {
    const popup = createPopup();

    expect(openTelegramDeepLink(popup, 'https://t.me/TalliMCP_bot?start=link_123')).toBe(true);
    expect(popup.location.href).toBe('https://t.me/TalliMCP_bot?start=link_123');
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('closes the placeholder popup when the link response is invalid or the API fails', () => {
    const invalidPopup = createPopup();
    const invalidResult = handleTelegramLinkResponse(invalidPopup, 'javascript:alert(1)');
    expect(invalidResult).toEqual({ status: 'invalid' });
    expect(invalidPopup.close).toHaveBeenCalledTimes(1);
    expect(invalidPopup.location.href).toBe('');

    const failurePopup = createPopup();
    const failureResult = handleTelegramLinkFailure(failurePopup);
    expect(failureResult).toEqual({ status: 'closed' });
    expect(failurePopup.close).toHaveBeenCalledTimes(1);
  });

  it('falls back cleanly when the popup is unavailable', () => {
    expect(handleTelegramLinkResponse(null, 'https://t.me/TalliMCP_bot?start=link_123')).toEqual({
      status: 'fallback',
    });
    expect(closeTelegramPopup(null)).toBe(false);
  });
});
