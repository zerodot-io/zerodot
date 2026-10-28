-- Databases made before the zerodot rename have poof_* insight functions. Rename them.
-- A database that already has the zerodot_* names is left as it is.
DO $$
BEGIN
  IF to_regprocedure('poof_add_arrays(integer[],integer[])') IS NOT NULL
     AND to_regprocedure('zerodot_add_arrays(integer[],integer[])') IS NULL THEN
    ALTER FUNCTION poof_add_arrays(integer[], integer[]) RENAME TO zerodot_add_arrays;
  END IF;
  IF to_regprocedure('poof_sum_arrays(integer[])') IS NOT NULL
     AND to_regprocedure('zerodot_sum_arrays(integer[])') IS NULL THEN
    ALTER AGGREGATE poof_sum_arrays(integer[]) RENAME TO zerodot_sum_arrays;
  END IF;
END $$;
