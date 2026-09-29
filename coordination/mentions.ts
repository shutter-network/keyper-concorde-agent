// Addressing a keyper room's operator by name.
//
// A reply to a message quotes it, and the room can see who is being answered. Nothing a teammates'
// group sets in motion has a message to quote -- a fan-out and a round's question both arrive
// unprompted -- so the room is shown a bare statement with no indication that its operator is the
// one being asked. An @handle on the first line is what replaces the quote there.
//
// Only a handle Telegram will resolve is written. A bare @name in plain text is linked by Telegram
// itself, which is why nothing here needs `parse_mode` -- turning that on would put every `<`, `&`
// and `_` an agent writes at risk of mangling the message or being refused outright, which is far
// too much to pay for a mention.
//
// A missing handle is not an error and not worth saying anything about: the message goes out exactly
// as it would have before. Nobody is worse off than they were, and a room told "your operator has no
// username" is being handed a problem it did not have.

/** The handles to address, in the order the operators are recorded, each seen once. */
export function handlesFor(
  operators: readonly string[],
  usernames: ReadonlyMap<string, string>,
): string[] {
  const found: string[] = [];
  for (const operator of operators) {
    const username = usernames.get(operator);
    // A room may record the same operator twice, and two rooms' operators are resolved together.
    if (username !== undefined && !found.includes(username)) found.push(username);
  }
  return found;
}

/**
 * `text` with its operators addressed on a line of their own, or `text` unchanged when not one of
 * them can be.
 *
 * Its own line rather than inline, so the message reads the same whether it is addressed or not:
 * everything below the first line is what the agent wrote, unedited and in its own words.
 */
export function addressed(
  text: string,
  operators: readonly string[],
  usernames: ReadonlyMap<string, string>,
): string {
  const handles = handlesFor(operators, usernames);
  if (handles.length === 0) return text;
  return `${handles.map((handle) => `@${handle}`).join(" ")}\n${text}`;
}
