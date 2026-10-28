import data from '../../models/catalog.json' with { type: 'json' };
export const catalog = {...data,models:[...data.models,...(data.variants??[])]};
export const CONTRIBUTION = {
  low: { label: 'Low', fraction: 0.35, threadFraction: 0.25, keepAlive: '5m', batch: 64 },
  medium: { label: 'Medium', fraction: 0.75, threadFraction: 0.5, keepAlive: '15m', batch: 128 },
  high: { label: 'High', fraction: 1, threadFraction: 1, keepAlive: '30m', batch: 512 }
};

export const DESKTOP_PLACEMENT = Object.freeze({forceMemory:true,minimumRank:3,minimumFraction:0.75,preferQuantized:true,keepAlive:-1});
