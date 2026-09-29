// Which chat covers which keyper.
//
// Shared by everything a teammates' group can set in motion: asking a keyperset for a time, and
// telling each keyper's operators something. Both resolve keypers to chats the same way and both
// have to say which keypers had no chat, so both read this rather than each keeping its own copy.

import type { Users } from "@shutter-network/concorde/users";

export type KeyperChat = { readonly userId: string; readonly keyper: string };

/**
 * Every keyper chat that can actually be written to, by the keyper it covers.
 *
 * `reachable` is asked of each candidate because a User having a keyper is not the same as being
 * reachable: `remove-chat` leaves the User, its attributes and its log behind, so a keyper can have
 * a User with no chat at all. Taking that User for the keyper's chat sends a message nobody
 * receives — and where two Users share a keyper, which one is taken comes down to the order
 * `users.list` happens to return.
 *
 * A list rather than one chat per keyper, because two chats may legitimately cover the same keyper
 * and both of their operators should hear. Keying by keyper alone silently wrote to one of them.
 *
 * Read fresh each time: a chat may be registered between one fan-out and the next, and a stale map
 * would quietly leave its operators out.
 */
export async function keyperChatsByKeyper(
  users: Users,
  reachable: (userId: string) => Promise<boolean>,
): Promise<Map<string, KeyperChat[]>> {
  const found = new Map<string, KeyperChat[]>();
  for (const user of await users.list()) {
    const { kind, keyper } = (user.attributes ?? {}) as { kind?: string; keyper?: string };
    if (kind !== "keyper" || typeof keyper !== "string" || keyper === "") continue;
    if (!(await reachable(user.id))) continue;
    found.set(keyper, [...(found.get(keyper) ?? []), { userId: user.id, keyper }]);
  }
  return found;
}

/**
 * Splits the keypers asked for into the ones with a chat and the ones without.
 *
 * `noChat` is the whole point of returning a pair: a keyper nobody can be reached about looks
 * exactly like one that was reached, unless somebody is told.
 */
export function splitByChat(
  chats: Map<string, KeyperChat[]>,
  keypers: readonly string[],
): { readonly reachable: KeyperChat[]; readonly noChat: string[] } {
  const reachable: KeyperChat[] = [];
  const noChat: string[] = [];
  for (const keyper of keypers) {
    const found = chats.get(keyper);
    if (found === undefined || found.length === 0) noChat.push(keyper);
    else reachable.push(...found);
  }
  return { reachable, noChat };
}
