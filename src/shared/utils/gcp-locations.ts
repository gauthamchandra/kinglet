/**
 * The GCP region list emulated `locations.list` / `locations.get` endpoints serve.
 *
 * <p>Cloud Workflows and Memorystore for Valkey each carry a private copy of this
 * list. AlloyDB would have been the third, so it moved here. The two incumbents
 * still use their own copies — replacing a working service's list belongs in its
 * own change, not in one adding a new service.
 *
 * <p><b>NOTE:</b> this is a representative list, not a per-service one. A GCP
 * service's real regional availability is not in its discovery document, so no
 * emulated `locations.list` here can be authoritative. Callers that reject
 * unlisted regions should say so in their own documentation.
 */

export interface GcpLocation {
  readonly locationId: string;
  readonly displayName: string;
}

const LOCATION_METADATA_TYPE = 'type.googleapis.com/google.cloud.location.Location';

export const GCP_LOCATIONS: readonly GcpLocation[] = [
  { locationId: 'us-central1', displayName: 'Council Bluffs, Iowa, USA' },
  { locationId: 'us-east1', displayName: 'Moncks Corner, South Carolina, USA' },
  { locationId: 'us-east4', displayName: 'Ashburn, Virginia, USA' },
  { locationId: 'us-west1', displayName: 'The Dalles, Oregon, USA' },
  { locationId: 'us-west2', displayName: 'Los Angeles, California, USA' },
  { locationId: 'us-west3', displayName: 'Salt Lake City, Utah, USA' },
  { locationId: 'us-west4', displayName: 'Las Vegas, Nevada, USA' },
  { locationId: 'europe-west1', displayName: 'St. Ghislain, Belgium' },
  { locationId: 'europe-west2', displayName: 'London, England, UK' },
  { locationId: 'europe-west3', displayName: 'Frankfurt, Germany' },
  { locationId: 'europe-west4', displayName: 'Eemshaven, Netherlands' },
  { locationId: 'europe-west6', displayName: 'Zurich, Switzerland' },
  { locationId: 'asia-east1', displayName: 'Changhua County, Taiwan' },
  { locationId: 'asia-east2', displayName: 'Hong Kong' },
  { locationId: 'asia-northeast1', displayName: 'Tokyo, Japan' },
  { locationId: 'asia-northeast2', displayName: 'Osaka, Japan' },
  { locationId: 'asia-southeast1', displayName: 'Jurong West, Singapore' },
  { locationId: 'australia-southeast1', displayName: 'Sydney, Australia' },
  { locationId: 'northamerica-northeast1', displayName: 'Montreal, Quebec, Canada' },
  { locationId: 'southamerica-east1', displayName: 'Osasco, Sao Paulo, Brazil' },
  { locationId: 'me-west1', displayName: 'Tel Aviv, Israel' },
];

export function findGcpLocation(locationId: string): GcpLocation | undefined {
  return GCP_LOCATIONS.find(location => location.locationId === locationId);
}

/** Render one location as `google.cloud.location.Location`. */
export function buildLocationResource(
  project: string,
  location: GcpLocation
): Record<string, unknown> {
  return {
    name: `projects/${project}/locations/${location.locationId}`,
    locationId: location.locationId,
    displayName: location.displayName,
    labels: {},
    metadata: { '@type': LOCATION_METADATA_TYPE },
  };
}
