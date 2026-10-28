-- Adds two integer arrays element by element. Insights use it for duration histograms.
CREATE FUNCTION zerodot_add_arrays(a integer[], b integer[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    ELSE (
      SELECT coalesce(array_agg(coalesce(x, 0) + coalesce(y, 0) ORDER BY i), '{}')
      FROM unnest(a, b) WITH ORDINALITY AS t(x, y, i)
    )
  END
$$;
--> statement-breakpoint
CREATE AGGREGATE zerodot_sum_arrays(integer[]) (SFUNC = zerodot_add_arrays, STYPE = integer[]);
