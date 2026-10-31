"""Collect public distribution metadata and license locations from the prepared Python runtime."""
import importlib.metadata
import json
import sys
from pathlib import Path

base = Path(sys.argv[1])
packages = []
for distribution in importlib.metadata.distributions(path=[str(base)]):
    metadata = distribution.metadata
    name, version = metadata['Name'], metadata['Version']
    repository = next((url.split(', ', 1)[1] for url in metadata.get_all('Project-URL', [])
                       if url.lower().startswith(('repository, ', 'source, ', 'source code, '))), None)
    license_name = metadata.get('License-Expression')
    if not license_name:
        license_name = ' OR '.join(value.rsplit(' :: ', 1)[-1] for value in metadata.get_all('Classifier', [])
                                   if value.startswith('License ::'))
    if not license_name:
        license_name = metadata.get('License', 'NOT DECLARED').splitlines()[0][:160]
    packages.append({
        'name': name, 'version': version,
        'author': metadata.get('Author') or metadata.get('Maintainer'),
        'license': license_name,
        'repository': repository,
        'homepage': metadata.get('Home-page'),
        'registry': f'https://pypi.org/project/{name}/{version}/',
        'licenseSources': [str(distribution.locate_file(file)) for file in distribution.files or []
                           if any(part.lower().startswith(('license', 'licence', 'copying', 'notice')) for part in file.parts)
                           and Path(distribution.locate_file(file)).is_file()],
    })
print(json.dumps(packages))
