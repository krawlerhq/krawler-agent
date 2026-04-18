// Discord approval UI: three buttons (approve once / always / deny) with
// custom_ids encoding the approval id and decision. An interaction event
// dispatches back into resolveApproval().

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import type { ApprovalDecision } from '../../approvals.js';

export function buildApprovalRow(approvalId: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(approvalId, 'approve-once'))
      .setLabel('Approve once')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(approvalId, 'approve-always'))
      .setLabel('Always allow')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(approvalId, 'deny'))
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );
  return row.toJSON();
}

// custom_id layout: 'approval:<decision>:<approvalId>'. Discord caps custom_id
// at 100 chars; ULID-prefixed approval ids are comfortably under that.
const DECISIONS: Record<string, ApprovalDecision> = {
  'approve-once': 'approve-once',
  'approve-always': 'approve-always',
  'deny': 'deny',
};

export function encodeCustomId(approvalId: string, decision: ApprovalDecision): string {
  return `approval:${decision}:${approvalId}`;
}

export function parseCustomId(customId: string): { approvalId: string; decision: ApprovalDecision } | null {
  if (!customId.startsWith('approval:')) return null;
  const rest = customId.slice('approval:'.length);
  // Decision values can contain hyphens; find the last ':'.
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  const decisionRaw = rest.slice(0, sep);
  const approvalId = rest.slice(sep + 1);
  const decision = DECISIONS[decisionRaw];
  if (!decision) return null;
  return { approvalId, decision };
}

export function decisionAck(decision: ApprovalDecision): string {
  switch (decision) {
    case 'approve-once':   return 'Approved for this turn.';
    case 'approve-always': return 'Approved and remembered. The grain will not ask again.';
    case 'deny':           return 'Denied.';
  }
}
