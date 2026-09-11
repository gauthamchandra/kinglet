/**
 * Load project-scoped Network Security address groups for Cloud Armor eval.
 *
 * The CEL engine stays sync (ADR-012). The evaluation server loads groups
 * once per request and hands evaluate() a lookup callback.
 */

import type { AddressGroupRepository } from '@/services/networksecurity/repository.ts';
import { parseAddressGroupName } from '@/services/networksecurity/types.ts';
import type { AddressGroupLookup } from './armor/expression.ts';

const ARMOR_ADDRESS_GROUP_LOCATION = 'global';

export function projectFromSecurityPolicySelfLink(selfLink: string): string | undefined {
  const match = selfLink.match(
    /\/compute\/v1\/projects\/([^/]+)\/global\/securityPolicies\/[^/]+$/
  );

  return match?.[1];
}

export async function loadAddressGroupLookup(
  repository: AddressGroupRepository,
  project: string
): Promise<AddressGroupLookup> {
  const groups = await repository.listAllAddressGroups(project, ARMOR_ADDRESS_GROUP_LOCATION);
  const itemsById = new Map<string, readonly string[]>();

  for (const group of groups) {
    const parsed = parseAddressGroupName(group.name);

    if (parsed == null) {
      continue;
    }

    itemsById.set(parsed.addressGroupId, parseItems(group.items));
  }

  return (groupName: string): readonly string[] | undefined => {
    const parsed = parseAddressGroupName(groupName);

    if (parsed != null) {
      if (parsed.project !== project || parsed.location !== ARMOR_ADDRESS_GROUP_LOCATION) {
        return undefined;
      }

      return itemsById.get(parsed.addressGroupId);
    }

    return itemsById.get(groupName);
  };
}

function parseItems(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      return [];
    }

    return parsed;
  } catch {
    return [];
  }
}
