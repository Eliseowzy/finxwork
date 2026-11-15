import { collageMembers } from "@finx/client";
import type { GroupMember } from "@finx/protocol";
import { Avatar } from "../bots/Avatar";

/**
 * A group's face (bot-group-chat-dev-brief §5): up to four of its members' avatars together, as a
 * chat app's group picture. Its members are the bots; there is no owner in the group to draw.
 */
export function GroupAvatar({ members, size = 36 }: { members: GroupMember[]; size?: 22 | 36 | 64 }) {
  const shown = collageMembers(members);
  const inner = size === 64 ? 28 : 22;
  return (
    <span className={`gav g${size} n${shown.length}`} aria-hidden="true">
      {shown.map((m) => (
        <Avatar key={m.bot_id} spec={m.avatar} name={m.name} size={inner} />
      ))}
    </span>
  );
}