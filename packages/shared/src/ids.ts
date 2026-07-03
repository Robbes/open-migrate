/** Nominal/branded primitive helper, so a TenantId can't be passed where a MappingId is wanted. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, 'TenantId'>;
export type MappingId = Brand<string, 'MappingId'>;

export const asTenantId = (s: string): TenantId => s as TenantId;
export const asMappingId = (s: string): MappingId => s as MappingId;
