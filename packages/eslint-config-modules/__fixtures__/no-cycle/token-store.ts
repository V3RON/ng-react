// Regression fixture for issue #43 / spec §13 B3 — the other half of the
// deliberate two-file cycle. See `session-service.ts` for the full rationale.
import { openSession } from './session-service';

const issued = new Map<string, string>();

export const refreshToken = (userId: string): string => {
  const token = `${userId}:${issued.size}`;
  issued.set(userId, token);
  return token;
};

export const reopen = (userId: string): ReturnType<typeof openSession> => openSession(userId);
