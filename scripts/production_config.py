"""Prepare local production configuration; never deploy or assert remote ownership."""


class ConfigurationError(ValueError):
    pass


def validate(data):
    import re
    if not isinstance(data, dict):
        raise ConfigurationError('Configuration must be an object')
    errors = []
    allowed = {'schemaVersion', 'domain', 'cloudflare', 'arc'}
    if set(data) - allowed:
        errors.append('Unknown root configuration fields')
    cf = data.get('cloudflare', {})
    arc = data.get('arc', {})
    if not isinstance(cf, dict) or not isinstance(arc, dict):
        raise ConfigurationError('cloudflare and arc must be objects')
    cf_fields = {'accountId', 'publicDatabaseId', 'chainDatabaseId', 'publicWorkerName', 'chainWorkerName'}
    arc_fields = {'chainId', 'rpcUrl', 'explorerUrl', 'usdc', 'manager', 'escrow', 'startBlock', 'genesisHash', 'managerCodeHash', 'escrowCodeHash'}
    if set(cf) - cf_fields or set(arc) - arc_fields:
        errors.append('Unknown configuration fields; secret values are not accepted')
    def matches(value, pattern):
        return isinstance(value, str) and re.fullmatch(pattern, value) is not None
    if type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1:
        errors.append('schemaVersion must be 1')
    if not matches(data.get('domain'), r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}'):
        errors.append('domain must be a canonical HTTPS hostname')
    if not matches(cf.get('accountId'), r'[a-fA-F0-9]{32}'):
        errors.append('cloudflare.accountId is required and must be a 32-hex identifier')
    for field in ['publicDatabaseId', 'chainDatabaseId']:
        if not matches(cf.get(field), r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}'):
            errors.append('cloudflare.' + field + ' must be an actual UUID identifier')
    for field in ['publicWorkerName', 'chainWorkerName']:
        if not matches(cf.get(field), r'[a-z0-9][a-z0-9-]{0,62}'):
            errors.append('cloudflare.' + field + ' is invalid')
    if cf.get('publicDatabaseId') and str(cf['publicDatabaseId']).casefold() == str(cf.get('chainDatabaseId')).casefold():
        errors.append('Public and private database identities must differ')
    if cf.get('publicWorkerName') and cf['publicWorkerName'] == cf.get('chainWorkerName'):
        errors.append('Public and private Worker identities must differ')
    if type(arc.get('chainId')) is not int or arc['chainId'] != 5042:
        errors.append('arc.chainId must be mainnet 5042')
    if arc.get('rpcUrl') != 'https://rpc.mainnet.arc.io' or arc.get('explorerUrl') != 'https://explorer.arc.io':
        errors.append('arc RPC/explorer must match the verified official mainnet metadata')
    token = '0x3600000000000000000000000000000000000000'
    if arc.get('usdc') != token:
        errors.append('arc.usdc must be the official native USDC ERC20 view')
    for field in ['manager', 'escrow']:
        value = arc.get(field)
        if not matches(value, r'0x[a-fA-F0-9]{40}') or value in ['0x' + '0' * 40, token]:
            errors.append('arc.' + field + ' requires an approved deployment address')
    if arc.get('manager') and str(arc['manager']).casefold() == str(arc.get('escrow')).casefold():
        errors.append('Manager and escrow must differ')
    block = arc.get('startBlock')
    if not matches(block, r'[1-9][0-9]{0,19}') or int(block) >= 2 ** 64:
        errors.append('arc.startBlock must be a canonical positive decimal block')
    for field in ['genesisHash', 'managerCodeHash', 'escrowCodeHash']:
        value = arc.get(field)
        if not matches(value, r'0x[a-fA-F0-9]{64}') or value == '0x' + '0' * 64:
            errors.append('arc.' + field + ' requires an approved exact hash')
    if errors:
        raise ConfigurationError('; '.join(errors))


def build_configs(data):
    validate(data)
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    cf, arc, domain = data['cloudflare'], data['arc'], data['domain']
    common = {'$schema': str(root / 'node_modules/wrangler/config-schema.json'), 'account_id': cf['accountId'], 'compatibility_date': '2026-11-08', 'workers_dev': False, 'preview_urls': False}
    public = {**common, 'name': cf['publicWorkerName'], 'main': str(root / 'worker/src/index.ts'), 'routes': [{'pattern': domain, 'custom_domain': True}], 'assets': {'directory': str(root / 'dist'), 'binding': 'ASSETS', 'not_found_handling': 'single-page-application', 'run_worker_first': ['/api/*']}, 'services': [{'binding': 'CHAIN', 'service': cf['chainWorkerName']}], 'secrets': {'required': ['SESSION_SECRET']}, 'vars': {'APP_ENV': 'production', 'APP_ORIGINS': 'https://' + domain, 'SIWE_DOMAIN': domain, 'SIWE_URI': 'https://' + domain, 'SIWE_CHAIN_ID': '5042', 'COOKIE_SECURE': 'true', 'EMAIL_MODE': 'disabled'}, 'd1_databases': [{'binding': 'DB', 'database_name': cf['publicWorkerName'] + '-production', 'database_id': cf['publicDatabaseId'], 'migrations_dir': str(root / 'worker/migrations')}]}
    private = {**common, 'name': cf['chainWorkerName'], 'main': str(root / 'chain-worker/src/index.ts'), 'routes': [], 'vars': {'APP_ENV': 'production', 'ARC_RPC_URL': arc['rpcUrl'], 'ARC_MANAGER_ADDRESS': arc['manager'], 'ARC_ESCROW_ADDRESS': arc['escrow'], 'ARC_START_BLOCK': arc['startBlock'], 'ARC_EXPECTED_GENESIS_HASH': arc['genesisHash'], 'ARC_EXPECTED_MANAGER_CODE_HASH': arc['managerCodeHash'], 'ARC_EXPECTED_ESCROW_CODE_HASH': arc['escrowCodeHash']}, 'd1_databases': [{'binding': 'CHAIN_DB', 'database_name': cf['chainWorkerName'] + '-production', 'database_id': cf['chainDatabaseId'], 'migrations_dir': str(root / 'chain-worker/migrations')}]}
    return {'public': public, 'private': private}


def main():
    import argparse
    import json
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='Local owner configuration JSON, never secret values')
    parser.add_argument('--write-dir', help='New directory strictly below .wrangler/production; never deploys')
    args = parser.parse_args()
    status = {'configurationValid': False, 'productionResourcesVerified': False, 'deploymentAuthorized': False}
    try:
        data = json.loads(Path(args.input).read_text())
        configs = build_configs(data)
        if args.write_dir:
            import tempfile
            base = Path(__file__).resolve().parents[1] / '.wrangler/production'
            output = Path(args.write_dir).resolve()
            if output == base or not output.is_relative_to(base):
                raise ConfigurationError('Write directory must stay below .wrangler/production')
            if output.exists():
                raise ConfigurationError('Refusing to overwrite an existing configuration directory')
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(dir=output.parent, prefix='.prepare-') as staging:
                for name, config in configs.items():
                    file = Path(staging) / (name + '.json')
                    file.write_text(json.dumps(config, indent=2) + '\n')
                    file.chmod(0o600)
                Path(staging).rename(output)
            status['files'] = [str(output / (name + '.json')) for name in configs]
        status.update(configurationValid=True, validatedConfigurations=len(configs))
        print(json.dumps(status))
        return 0
    except ConfigurationError as error:
        status['errors'] = str(error)
    except (OSError, json.JSONDecodeError):
        status['errors'] = 'Cannot read or write local configuration safely'
    print(json.dumps(status))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())

