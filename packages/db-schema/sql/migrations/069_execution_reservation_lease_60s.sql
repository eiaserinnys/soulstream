-- Execution reservations are a crash-only backstop. Every non-crash failure is
-- compensated immediately, while prove/orphan/adopt refresh the lease at the
-- next lifecycle boundary. Keep the maximum crash recovery delay to one minute.
DO $migration$
DECLARE
    v_function_name TEXT;
    v_definition TEXT;
    v_updated_definition TEXT;
BEGIN
    FOREACH v_function_name IN ARRAY ARRAY[
        'session_reserve_execution_ownership',
        'session_prove_execution_ownership',
        'session_mark_execution_orphaned_spawn',
        'session_reserve_execution_adoption'
    ] LOOP
        SELECT pg_get_functiondef(procedure.oid)
          INTO STRICT v_definition
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = current_schema()
           AND procedure.proname = v_function_name;

        v_updated_definition := replace(
            v_definition,
            'INTERVAL ''5 minutes''',
            'INTERVAL ''60 seconds'''
        );
        IF v_updated_definition = v_definition THEN
            RAISE EXCEPTION '% does not contain the expected five-minute lease',
                v_function_name;
        END IF;
        EXECUTE v_updated_definition;
    END LOOP;
END;
$migration$;
