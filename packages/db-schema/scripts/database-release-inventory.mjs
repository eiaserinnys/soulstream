import { createHash } from "node:crypto";

function canonicalObject(row) {
  return {
    kind: String(row.kind),
    identity: String(row.identity),
    object_oid: String(row.object_oid),
    definition: row.definition === null || row.definition === undefined
      ? ""
      : String(row.definition),
  };
}

export function canonicalInventoryDigest(objects) {
  const canonical = objects.map(canonicalObject).sort((left, right) => (
    `${left.kind}\0${left.identity}\0${left.object_oid}\0${left.definition}`
      .localeCompare(`${right.kind}\0${right.identity}\0${right.object_oid}\0${right.definition}`)
  ));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function fingerprintInventory(inventory) {
  if (/^[a-f0-9]{64}$/.test(inventory?.object_fingerprint ?? "")) {
    return inventory.object_fingerprint;
  }
  const canonical = {
    relation_count: Number(inventory.relation_count),
    routine_count: Number(inventory.routine_count),
    type_count: Number(inventory.type_count),
    ledger_count: Number(inventory.ledger_count),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function inspectUserObjectInventory(sql) {
  const objects = await sql.unsafe(`
    WITH extension_owned AS (
      SELECT classid, objid
      FROM pg_depend
      WHERE deptype = 'e'
    ), user_namespaces AS (
      SELECT oid, nspname, nspacl
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
        AND nspname !~ '^pg_toast'
        AND nspname !~ '^pg_temp_'
    ), all_user_namespaces AS (
      SELECT oid, nspname
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema')
        AND nspname !~ '^pg_toast'
        AND nspname !~ '^pg_temp_'
    )
    SELECT * FROM (
      SELECT 'schema'::text AS kind, namespace.nspname::text AS identity,
        namespace.oid::text AS object_oid,
        COALESCE(namespace.nspacl::text, '') AS definition
      FROM user_namespaces namespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_namespace'::regclass AND owned.objid = namespace.oid
      )
      UNION ALL
      SELECT 'extension', extension.extname, extension.oid::text,
        jsonb_build_object(
          'version', extension.extversion,
          'schema', namespace.nspname,
          'relocatable', extension.extrelocatable
        )::text
      FROM pg_extension extension
      JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
      WHERE extension.extname <> 'plpgsql'
      UNION ALL
      SELECT 'relation', namespace.nspname || '.' || object.relname,
        object.oid::text,
        jsonb_build_object(
          'kind', object.relkind,
          'persistence', object.relpersistence,
          'owner', object.relowner::regrole::text,
          'access_method', access_method.amname,
          'tablespace', object.reltablespace,
          'row_security', object.relrowsecurity,
          'force_row_security', object.relforcerowsecurity,
          'replica_identity', object.relreplident,
          'acl', object.relacl,
          'options', object.reloptions,
          'partition', CASE WHEN object.relkind = 'p'
            THEN pg_get_partkeydef(object.oid) ELSE NULL END,
          'partition_bound', pg_get_expr(object.relpartbound, object.oid),
          'view', CASE WHEN object.relkind IN ('v', 'm')
            THEN pg_get_viewdef(object.oid, true) ELSE NULL END
        )::text
      FROM pg_class object
      JOIN all_user_namespaces namespace ON namespace.oid = object.relnamespace
      LEFT JOIN pg_am access_method ON access_method.oid = object.relam
      WHERE object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_class'::regclass AND owned.objid = object.oid
        )
      UNION ALL
      SELECT 'column', namespace.nspname || '.' || relation.relname || '.' || attribute.attname,
        (relation.oid::text || ':' || attribute.attnum::text),
        jsonb_build_object(
          'type', format_type(attribute.atttypid, attribute.atttypmod),
          'not_null', attribute.attnotnull,
          'identity', attribute.attidentity,
          'generated', attribute.attgenerated,
          'acl', attribute.attacl,
          'default', pg_get_expr(default_value.adbin, default_value.adrelid),
          'collation', attribute.attcollation::regcollation::text
        )::text
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_class'::regclass AND owned.objid = relation.oid
        )
      UNION ALL
      SELECT 'constraint', namespace.nspname || '.' || constraint_value.conname,
        constraint_value.oid::text, pg_get_constraintdef(constraint_value.oid, true)
      FROM pg_constraint constraint_value
      JOIN pg_namespace namespace ON namespace.oid = constraint_value.connamespace
      JOIN all_user_namespaces allowed ON allowed.oid = namespace.oid
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_constraint'::regclass
          AND owned.objid = constraint_value.oid
      )
      UNION ALL
      SELECT 'index', namespace.nspname || '.' || index_relation.relname,
        index_relation.oid::text, pg_get_indexdef(index_relation.oid)
      FROM pg_index index_value
      JOIN pg_class index_relation ON index_relation.oid = index_value.indexrelid
      JOIN all_user_namespaces namespace ON namespace.oid = index_relation.relnamespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_class'::regclass AND owned.objid = index_relation.oid
      )
      UNION ALL
      SELECT 'trigger', namespace.nspname || '.' || relation.relname || '.' || trigger.tgname,
        trigger.oid::text,
        jsonb_build_object(
          'definition', pg_get_triggerdef(trigger.oid, true),
          'enabled', trigger.tgenabled
        )::text
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      WHERE NOT trigger.tgisinternal
      UNION ALL
      SELECT 'policy', namespace.nspname || '.' || relation.relname || '.' || policy.polname,
        policy.oid::text,
        jsonb_build_object(
          'command', policy.polcmd,
          'permissive', policy.polpermissive,
          'roles', policy.polroles,
          'using', pg_get_expr(policy.polqual, policy.polrelid),
          'check', pg_get_expr(policy.polwithcheck, policy.polrelid)
        )::text
      FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      UNION ALL
      SELECT 'routine', namespace.nspname || '.' || routine.proname ||
          '(' || pg_get_function_identity_arguments(routine.oid) || ')',
        routine.oid::text,
        jsonb_build_object(
          'kind', routine.prokind,
          'language', routine.prolang,
          'owner', routine.proowner::regrole::text,
          'acl', routine.proacl,
          'returns', routine.prorettype,
          'source', routine.prosrc,
          'binary', routine.probin,
          'config', routine.proconfig,
          'volatility', routine.provolatile,
          'parallel', routine.proparallel,
          'security_definer', routine.prosecdef,
          'strict', routine.proisstrict
        )::text
      FROM pg_proc routine
      JOIN all_user_namespaces namespace ON namespace.oid = routine.pronamespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_proc'::regclass AND owned.objid = routine.oid
      )
      UNION ALL
      SELECT 'type', namespace.nspname || '.' || type_value.typname,
        type_value.oid::text,
        jsonb_build_object(
          'kind', type_value.typtype,
          'category', type_value.typcategory,
          'base', type_value.typbasetype,
          'not_null', type_value.typnotnull,
          'default', type_value.typdefault,
          'enum', (SELECT jsonb_agg(enum.enumlabel ORDER BY enum.enumsortorder)
                   FROM pg_enum enum WHERE enum.enumtypid = type_value.oid),
          'range_subtype', range_value.rngsubtype
          , 'owner', type_value.typowner::regrole::text
          , 'acl', type_value.typacl
          , 'collation', type_value.typcollation
        )::text
      FROM pg_type type_value
      JOIN all_user_namespaces namespace ON namespace.oid = type_value.typnamespace
      LEFT JOIN pg_range range_value ON range_value.rngtypid = type_value.oid
      WHERE type_value.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
        AND type_value.typname !~ '^_'
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_type'::regclass AND owned.objid = type_value.oid
        )
      UNION ALL
      SELECT 'operator', namespace.nspname || '.' || operator_value.oprname ||
          '(' || operator_value.oprleft::regtype::text || ',' || operator_value.oprright::regtype::text || ')',
        operator_value.oid::text,
        jsonb_build_object('code', operator_value.oprcode, 'result', operator_value.oprresult)::text
      FROM pg_operator operator_value
      JOIN all_user_namespaces namespace ON namespace.oid = operator_value.oprnamespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_operator'::regclass AND owned.objid = operator_value.oid
      )
      UNION ALL
      SELECT 'collation', namespace.nspname || '.' || collation_value.collname,
        collation_value.oid::text,
        jsonb_build_object(
          'provider', collation_value.collprovider,
          'deterministic', collation_value.collisdeterministic,
          'collate', collation_value.collcollate,
          'ctype', collation_value.collctype,
          'locale', COALESCE(
            to_jsonb(collation_value)->>'colllocale',
            to_jsonb(collation_value)->>'colliculocale'
          )
        )::text
      FROM pg_collation collation_value
      JOIN all_user_namespaces namespace ON namespace.oid = collation_value.collnamespace
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_collation'::regclass AND owned.objid = collation_value.oid
      )
      UNION ALL
      SELECT 'conversion', namespace.nspname || '.' || conversion_value.conname,
        conversion_value.oid::text,
        jsonb_build_object(
          'from', conversion_value.conforencoding,
          'to', conversion_value.contoencoding,
          'function', conversion_value.conproc,
          'default', conversion_value.condefault
        )::text
      FROM pg_conversion conversion_value
      JOIN all_user_namespaces namespace ON namespace.oid = conversion_value.connamespace
      UNION ALL
      SELECT 'text_search_configuration', namespace.nspname || '.' || config.cfgname,
        config.oid::text, config.cfgparser::text
      FROM pg_ts_config config
      JOIN all_user_namespaces namespace ON namespace.oid = config.cfgnamespace
      UNION ALL
      SELECT 'text_search_mapping', namespace.nspname || '.' || config.cfgname || ':' ||
          mapping.maptokentype::text || ':' || mapping.mapseqno::text,
        (config.oid::text || ':' || mapping.maptokentype::text || ':' || mapping.mapseqno::text),
        mapping.mapdict::text
      FROM pg_ts_config_map mapping
      JOIN pg_ts_config config ON config.oid = mapping.mapcfg
      JOIN all_user_namespaces namespace ON namespace.oid = config.cfgnamespace
      UNION ALL
      SELECT 'text_search_dictionary', namespace.nspname || '.' || dictionary.dictname,
        dictionary.oid::text,
        jsonb_build_object('template', dictionary.dicttemplate, 'options', dictionary.dictinitoption)::text
      FROM pg_ts_dict dictionary
      JOIN all_user_namespaces namespace ON namespace.oid = dictionary.dictnamespace
      UNION ALL
      SELECT 'text_search_parser', namespace.nspname || '.' || parser_value.prsname,
        parser_value.oid::text,
        jsonb_build_object('start', parser_value.prsstart, 'token', parser_value.prstoken,
          'end', parser_value.prsend, 'headline', parser_value.prsheadline,
          'lextypes', parser_value.prslextype)::text
      FROM pg_ts_parser parser_value
      JOIN all_user_namespaces namespace ON namespace.oid = parser_value.prsnamespace
      UNION ALL
      SELECT 'text_search_template', namespace.nspname || '.' || template.tmplname,
        template.oid::text,
        jsonb_build_object('init', template.tmplinit, 'lexize', template.tmpllexize)::text
      FROM pg_ts_template template
      JOIN all_user_namespaces namespace ON namespace.oid = template.tmplnamespace
      UNION ALL
      SELECT 'foreign_data_wrapper', wrapper.fdwname, wrapper.oid::text,
        jsonb_build_object('handler', wrapper.fdwhandler, 'validator', wrapper.fdwvalidator,
          'owner', wrapper.fdwowner::regrole::text, 'acl', wrapper.fdwacl,
          'options_digest', md5(COALESCE(array_to_string(wrapper.fdwoptions, ','), '')))::text
      FROM pg_foreign_data_wrapper wrapper
      WHERE NOT EXISTS (
        SELECT 1 FROM extension_owned owned
        WHERE owned.classid = 'pg_foreign_data_wrapper'::regclass AND owned.objid = wrapper.oid
      )
      UNION ALL
      SELECT 'foreign_server', server_value.srvname, server_value.oid::text,
        jsonb_build_object('fdw', server_value.srvfdw, 'type', server_value.srvtype,
          'version', server_value.srvversion, 'owner', server_value.srvowner::regrole::text,
          'acl', server_value.srvacl,
          'options_digest', md5(COALESCE(array_to_string(server_value.srvoptions, ','), '')))::text
      FROM pg_foreign_server server_value
      UNION ALL
      SELECT 'foreign_table', namespace.nspname || '.' || relation.relname,
        foreign_table.ftrelid::text,
        jsonb_build_object('server', foreign_table.ftserver,
          'options_digest', md5(COALESCE(array_to_string(foreign_table.ftoptions, ','), '')))::text
      FROM pg_foreign_table foreign_table
      JOIN pg_class relation ON relation.oid = foreign_table.ftrelid
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      UNION ALL
      SELECT 'user_mapping', server_value.srvname || ':' ||
          CASE WHEN mapping.umuser = 0 THEN 'PUBLIC' ELSE mapping.umuser::regrole::text END,
        mapping.oid::text,
        jsonb_build_object('server', mapping.umserver,
          'options_digest', md5(COALESCE(array_to_string(mapping.umoptions, ','), '')))::text
      FROM pg_user_mapping mapping
      JOIN pg_foreign_server server_value ON server_value.oid = mapping.umserver
      UNION ALL
      SELECT 'publication', publication.pubname, publication.oid::text,
        jsonb_build_object('all_tables', publication.puballtables,
          'insert', publication.pubinsert, 'update', publication.pubupdate,
          'delete', publication.pubdelete, 'truncate', publication.pubtruncate,
          'via_root', publication.pubviaroot,
          'owner', publication.pubowner::regrole::text)::text
      FROM pg_publication publication
      UNION ALL
      SELECT 'publication_relation', publication.pubname || ':' ||
          namespace.nspname || '.' || relation.relname,
        membership.oid::text,
        jsonb_build_object('columns', membership.prattrs,
          'qualifier', pg_get_expr(membership.prqual, membership.prrelid))::text
      FROM pg_publication_rel membership
      JOIN pg_publication publication ON publication.oid = membership.prpubid
      JOIN pg_class relation ON relation.oid = membership.prrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      UNION ALL
      SELECT 'publication_schema', publication.pubname || ':' || namespace.nspname,
        membership.oid::text, ''
      FROM pg_publication_namespace membership
      JOIN pg_publication publication ON publication.oid = membership.pnpubid
      JOIN pg_namespace namespace ON namespace.oid = membership.pnnspid
      UNION ALL
      SELECT 'event_trigger', event_trigger.evtname, event_trigger.oid::text,
        jsonb_build_object('event', event_trigger.evtevent, 'owner', event_trigger.evtowner,
          'function', event_trigger.evtfoid, 'enabled', event_trigger.evtenabled,
          'tags', event_trigger.evttags)::text
      FROM pg_event_trigger event_trigger
      UNION ALL
      SELECT 'rule', namespace.nspname || '.' || relation.relname || '.' || rule.rulename,
        rule.oid::text,
        jsonb_build_object('event', rule.ev_type, 'enabled', rule.ev_enabled,
          'instead', rule.is_instead, 'action', pg_get_ruledef(rule.oid, true))::text
      FROM pg_rewrite rule
      JOIN pg_class relation ON relation.oid = rule.ev_class
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      WHERE rule.rulename <> '_RETURN'
      UNION ALL
      SELECT 'inheritance', child_namespace.nspname || '.' || child.relname || '->' ||
          parent_namespace.nspname || '.' || parent.relname,
        (inheritance.inhrelid::text || ':' || inheritance.inhparent::text),
        jsonb_build_object('sequence', inheritance.inhseqno,
          'detach_pending', inheritance.inhdetachpending)::text
      FROM pg_inherits inheritance
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      JOIN all_user_namespaces allowed ON allowed.oid = child_namespace.oid
      UNION ALL
      SELECT 'sequence', namespace.nspname || '.' || relation.relname,
        relation.oid::text,
        jsonb_build_object('type', sequence.seqtypid, 'start', sequence.seqstart,
          'increment', sequence.seqincrement, 'max', sequence.seqmax,
          'min', sequence.seqmin, 'cache', sequence.seqcache,
          'cycle', sequence.seqcycle)::text
      FROM pg_sequence sequence
      JOIN pg_class relation ON relation.oid = sequence.seqrelid
      JOIN all_user_namespaces namespace ON namespace.oid = relation.relnamespace
      UNION ALL
      SELECT 'operator_class', namespace.nspname || '.' || operator_class.opcname,
        operator_class.oid::text,
        jsonb_build_object('method', operator_class.opcmethod,
          'family', operator_class.opcfamily, 'input', operator_class.opcintype,
          'default', operator_class.opcdefault, 'key', operator_class.opckeytype)::text
      FROM pg_opclass operator_class
      JOIN all_user_namespaces namespace ON namespace.oid = operator_class.opcnamespace
      UNION ALL
      SELECT 'operator_family', namespace.nspname || '.' || family.opfname,
        family.oid::text, family.opfmethod::text
      FROM pg_opfamily family
      JOIN all_user_namespaces namespace ON namespace.oid = family.opfnamespace
      UNION ALL
      SELECT 'cast', cast_value.castsource::regtype::text || '->' ||
          cast_value.casttarget::regtype::text,
        cast_value.oid::text,
        jsonb_build_object('function', cast_value.castfunc,
          'context', cast_value.castcontext, 'method', cast_value.castmethod)::text
      FROM pg_cast cast_value
      WHERE cast_value.oid >= 16384
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_cast'::regclass AND owned.objid = cast_value.oid
        )
      UNION ALL
      SELECT 'language', language.lanname, language.oid::text,
        jsonb_build_object('trusted', language.lanpltrusted,
          'handler', language.lanplcallfoid, 'inline', language.laninline,
          'validator', language.lanvalidator, 'acl', language.lanacl)::text
      FROM pg_language language
      WHERE language.oid >= 16384
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_language'::regclass AND owned.objid = language.oid
        )
      UNION ALL
      SELECT 'transform', transform.trftype::regtype::text || ':' || language.lanname,
        transform.oid::text,
        jsonb_build_object('from_sql', transform.trffromsql,
          'to_sql', transform.trftosql)::text
      FROM pg_transform transform
      JOIN pg_language language ON language.oid = transform.trflang
      WHERE transform.oid >= 16384
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_transform'::regclass AND owned.objid = transform.oid
        )
      UNION ALL
      SELECT 'access_method', access_method.amname, access_method.oid::text,
        jsonb_build_object('handler', access_method.amhandler,
          'type', access_method.amtype)::text
      FROM pg_am access_method
      WHERE access_method.oid >= 16384
        AND NOT EXISTS (
          SELECT 1 FROM extension_owned owned
          WHERE owned.classid = 'pg_am'::regclass AND owned.objid = access_method.oid
        )
      UNION ALL
      SELECT 'default_acl', default_acl.defaclrole::regrole::text || ':' ||
          COALESCE(namespace.nspname, '*') || ':' || default_acl.defaclobjtype::text,
        default_acl.oid::text, default_acl.defaclacl::text
      FROM pg_default_acl default_acl
      LEFT JOIN pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
      UNION ALL
      SELECT 'large_object', large_object.oid::text, large_object.oid::text,
        jsonb_build_object('owner', large_object.lomowner::regrole::text,
          'acl', large_object.lomacl)::text
      FROM pg_largeobject_metadata large_object
      UNION ALL
      SELECT 'subscription', subscription.subname, subscription.oid::text,
        jsonb_build_object('owner', subscription.subowner::regrole::text,
          'enabled', subscription.subenabled, 'binary', subscription.subbinary,
          'stream', subscription.substream, 'slot', subscription.subslotname,
          'publications', subscription.subpublications,
          'connection_digest', md5(subscription.subconninfo))::text
      FROM pg_subscription subscription
      UNION ALL
      SELECT 'extended_statistics', namespace.nspname || '.' || statistics.stxname,
        statistics.oid::text,
        jsonb_build_object('relation', statistics.stxrelid, 'keys', statistics.stxkeys,
          'kind', statistics.stxkind, 'expressions', pg_get_statisticsobjdef_expressions(statistics.oid))::text
      FROM pg_statistic_ext statistics
      JOIN all_user_namespaces namespace ON namespace.oid = statistics.stxnamespace
    ) inventory
    ORDER BY kind, identity, object_oid, definition
  `);
  const canonical = objects.map(canonicalObject);
  const relationCount = canonical.filter((item) => item.kind === "relation").length;
  const routineCount = canonical.filter((item) => item.kind === "routine").length;
  const typeCount = canonical.filter((item) => item.kind === "type").length;
  const ledgerTable = await sql`SELECT to_regclass('schema_migrations')::text AS name`;
  const ledger = ledgerTable[0]?.name
    ? await sql`SELECT COUNT(*)::int AS count FROM schema_migrations`
    : [{ count: 0 }];
  return {
    object_count: canonical.length,
    object_fingerprint: canonicalInventoryDigest(canonical),
    objects: canonical,
    relation_count: relationCount,
    routine_count: routineCount,
    type_count: typeCount,
    ledger_count: Number(ledger[0].count),
  };
}
