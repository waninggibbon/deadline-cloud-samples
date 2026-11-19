// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

// Resolves the principals a notification is addressed to into recipients: a
// person or team with their preferences and, where one is known, an email
// address.

import { Logger } from './log';
import { Preferences } from './preferences';
import { Principal, PrincipalType } from './types';

/** IAM Identity Center lookups. */
export interface IdentityDirectory {
  /** Whether an identity store is configured. When it is not, nothing can be looked up. */
  readonly configured: boolean;
  /** A user's primary email address, or `undefined` for an unknown user or one with none. */
  userEmail(userId: string): Promise<string | undefined>;
  /** The user IDs of a group's direct members, at most `limit` of them. */
  groupMembers(groupId: string, limit: number): Promise<{ userIds: string[]; truncated: boolean }>;
}

export interface PreferencesStore {
  get(principalId: string): Promise<Preferences | undefined>;
}

export interface Recipient {
  readonly type: PrincipalType;
  readonly principalId: string;
  readonly email?: string;
  readonly preferences?: Preferences;
}

/** Why a principal produced no recipient. Logged, never an error. */
export interface Unresolved {
  readonly principal: Principal;
  readonly reason: string;
}

export interface Resolution {
  readonly recipients: Recipient[];
  readonly unresolved: Unresolved[];
}

export interface ResolveOptions {
  readonly identity: IdentityDirectory;
  readonly preferences: PreferencesStore;
  readonly maxGroupMembers: number;
  readonly log: Logger;
}

/**
 * Resolve principals to recipients, each person at most once.
 *
 * - A user gets their preferences, and the email address from their
 *   preferences or from the identity store.
 * - A group is expanded to its direct members, each resolved as a user. The
 *   group is also a recipient in its own right when it has preferences, which
 *   is how a team channel is notified.
 * - An IAM principal has no directory entry, so it is a recipient only when it
 *   has preferences, and is skipped otherwise.
 */
export async function resolveRecipients(
  audience: readonly Principal[],
  options: ResolveOptions,
): Promise<Resolution> {
  const recipients = new Map<string, Recipient>();
  const unresolved: Unresolved[] = [];

  const addUser = async (userId: string): Promise<void> => {
    if (recipients.has(userId)) return;
    const preferences = await options.preferences.get(userId);
    const email =
      preferences?.email ??
      (options.identity.configured ? await options.identity.userEmail(userId) : undefined);
    recipients.set(userId, { type: 'USER', principalId: userId, email, preferences });
  };

  for (const principal of dedupePrincipals(audience)) {
    switch (principal.type) {
      case 'USER':
        await addUser(principal.id);
        break;
      case 'GROUP': {
        const groupPreferences = await options.preferences.get(principal.id);
        if (groupPreferences && !recipients.has(principal.id)) {
          recipients.set(principal.id, {
            type: 'GROUP',
            principalId: principal.id,
            email: groupPreferences.email,
            preferences: groupPreferences,
          });
        }
        if (!options.identity.configured) {
          unresolved.push({ principal, reason: 'IdentityStoreNotConfigured' });
          break;
        }
        const { userIds, truncated } = await options.identity.groupMembers(
          principal.id,
          options.maxGroupMembers,
        );
        if (truncated) {
          options.log.warn('Group has more members than MAX_GROUP_MEMBERS; notifying the first ones', {
            groupId: principal.id,
            maxGroupMembers: options.maxGroupMembers,
          });
        }
        for (const userId of userIds) {
          await addUser(userId);
        }
        break;
      }
      case 'IAM': {
        const preferences = await options.preferences.get(principal.id);
        if (!preferences) {
          unresolved.push({ principal, reason: 'IamPrincipalWithoutPreferences' });
          break;
        }
        recipients.set(principal.id, {
          type: 'IAM',
          principalId: principal.id,
          email: preferences.email,
          preferences,
        });
        break;
      }
    }
  }

  return { recipients: [...recipients.values()], unresolved };
}

function dedupePrincipals(audience: readonly Principal[]): Principal[] {
  const seen = new Set<string>();
  return audience.filter((principal) => {
    const key = `${principal.type}:${principal.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
