/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<number>} */
export async function quarantinePasskeyChallenges(client) {
  const exists = (await client.query("SELECT to_regclass('public.account_passkey_challenges') IS NOT NULL AS present")).rows[0].present;
  if (!exists) return 0;
  return (await client.query("DELETE FROM account_passkey_challenges")).rowCount;
}
