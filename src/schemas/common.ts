/**
 * Shared validation patterns for consistent input validation
 */

// Shared regex patterns
export const ADDRESS = '^(0x[a-fA-F0-9]{40}|PLS)$';
export const TX_HASH = '^0x[a-fA-F0-9]{64}$';
export const REFERRAL_CODE = '^[A-Z0-9]{8}$';
