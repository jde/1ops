// Example seed file — fake data, safe to publish. In a real repo this is your
// actual prisma/seed.ts (or equivalent). 1ops reads it live so the dev logins
// it shows you are ALWAYS the ones your seed script actually creates.
export const devUsers = [
  { email: "admin@acme.test", password: "password123", role: "admin" },
  { email: "member@acme.test", password: "password123", role: "member" },
  { email: "readonly@acme.test", password: "password123", role: "viewer" },
];
