-- Tests wrote the fake `chat` messenger of src/testing/shared-program.ts into real stores until a test could no longer
-- open one (#2438). Deleting an account is the store's own purge, in code (every child row, the people only it saw,
-- the vectors only it held), so the next writable open removes every `chat` account and deletes this key
-- (purgeTestAccounts). A store without one gets no key, so a test's own `chat` rows written after this stay.
INSERT OR REPLACE INTO store_settings (key, value, at)
SELECT 'test_accounts_to_purge', '1', unixepoch() * 1000 WHERE EXISTS (SELECT 1 FROM accounts WHERE provider = 'chat');
