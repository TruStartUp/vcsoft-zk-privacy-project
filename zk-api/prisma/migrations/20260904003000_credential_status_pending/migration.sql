-- A credential now exists before it has a commitment: the identity check clears
-- first, and the holder supplies `secretHash` afterwards.
--
-- On its own, so the new label is committed before the next migration builds an
-- index whose predicate names it.
ALTER TYPE "CredentialStatus" ADD VALUE 'PENDING' BEFORE 'ACTIVE';
