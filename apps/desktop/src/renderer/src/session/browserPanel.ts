// The browser panel comes out by itself with a conversation's first page. Once the person puts
// it away in a conversation it stays away there, whatever the agent does and however often they
// come back, until they bring it out again (browser-design §8.3.4).

const putAway = new Set<string>();

export const browserPutAway = (session: string) => putAway.has(session);
export const putBrowserAway = (session: string) => void putAway.add(session);
export const bringBrowserBack = (session: string) => void putAway.delete(session);
