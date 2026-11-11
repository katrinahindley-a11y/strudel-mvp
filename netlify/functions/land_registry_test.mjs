function reply(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export default async (request) => {
  // Keep this temporary diagnostic off the production site.
  if (process.env.CONTEXT !== 'deploy-preview' &&
      process.env.CONTEXT !== 'branch-deploy') {
    return reply({ error: 'Preview environments only' }, 404);
  }

  if (request.method !== 'GET') {
    return reply({ error: 'GET required' }, 405);
  }

  const key = process.env.Land_registry?.trim();

  if (!key) {
    return reply({
      connected: false,
      error: 'Land_registry is not configured for this preview.'
    }, 503);
  }

  try {
    const response = await fetch(
      'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod',
      {
        headers: {
          Authorization: key,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error'
      }
    );

    if (!response.ok) {
      return reply({
        connected: false,
        upstream_status: response.status,
        error: 'Land Registry did not accept the metadata request.'
      }, 502);
    }

    const body = await response.json();

    if (body.success !== true || !body.result) {
      return reply({
        connected: false,
        error: 'Land Registry returned an unexpected response.'
      }, 502);
    }

    const dataset = body.result;
    const resources = Array.isArray(dataset.resources)
      ? dataset.resources
      : [];

    return reply({
      connected: true,
      dataset: dataset.name,
      title: dataset.title,
      last_updated: dataset.last_updated,
      update_frequency: dataset.update_frequency,
      files: resources.map((file) => ({
        name: file.name,
        file_name: file.file_name,
        file_size: file.file_size,
        row_count: file.row_count
      })),
      note: 'Metadata access confirmed. Download permission is not yet tested.'
    });
  } catch {
    return reply({
      connected: false,
      error: 'Connection test failed or timed out. No data was imported.'
    }, 502);
  }
};
