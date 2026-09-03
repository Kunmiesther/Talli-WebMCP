export function isValidTelegramDeepLink(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 't.me' || url.hostname === 'telegram.me');
  } catch {
    return false;
  }
}

export function closeTelegramPopup(popup) {
  if (!popup || popup.closed) {
    return false;
  }

  try {
    popup.close();
    return true;
  } catch {
    return false;
  }
}

export function openTelegramDeepLink(popup, deepLink) {
  if (!popup || popup.closed) {
    return false;
  }

  if (!isValidTelegramDeepLink(deepLink)) {
    return false;
  }

  popup.location.href = deepLink;
  return true;
}

export function handleTelegramLinkResponse(popup, deepLink) {
  if (!isValidTelegramDeepLink(deepLink)) {
    closeTelegramPopup(popup);
    return {
      status: 'invalid',
    };
  }

  if (!openTelegramDeepLink(popup, deepLink)) {
    return {
      status: 'fallback',
    };
  }

  return {
    status: 'opened',
  };
}

export function handleTelegramLinkFailure(popup) {
  closeTelegramPopup(popup);
  return {
    status: 'closed',
  };
}
