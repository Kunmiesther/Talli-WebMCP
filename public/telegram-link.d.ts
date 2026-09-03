export interface TelegramPopupHandle {
  closed: boolean;
  close(): void;
  location: {
    href: string;
  };
}

export function isValidTelegramDeepLink(value: string | null | undefined): boolean;
export function closeTelegramPopup(popup: TelegramPopupHandle | null | undefined): boolean;
export function openTelegramDeepLink(
  popup: Pick<TelegramPopupHandle, 'location' | 'closed'> | null | undefined,
  deepLink: string | null | undefined,
): boolean;
export function handleTelegramLinkResponse(
  popup: TelegramPopupHandle | Pick<TelegramPopupHandle, 'location' | 'closed'> | null | undefined,
  deepLink: string | null | undefined,
): {
  status: 'opened' | 'fallback' | 'invalid';
};
export function handleTelegramLinkFailure(popup: TelegramPopupHandle | null | undefined): {
  status: 'closed';
};
