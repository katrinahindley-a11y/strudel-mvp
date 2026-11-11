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
  // Allow this temporary diagnostic only on the PR #5 preview.
  const hostname = new URL(request.url).hostname;

  if (hostname !== 'deploy-preview-5--strudelproperty.netlify.app') {
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

    const downloadCheck = await fetch(
      'https://use-land-property-data.service.gov.uk/api/v1/datasets/ccod/CCOD_FULL_2026_11.zip',
      {
        headers: {
          Authorization: key,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error'
      }
    );

    if (!downloadCheck.ok) {
      return reply({
        connected: true,
        download_access: false,
        upstream_status: downloadCheck.status,
        error: 'Metadata works, but the download-link request failed.'
      }, 502);
    }

    const downloadBody = await downloadCheck.json();

    if (
      downloadBody.success !== true ||
      typeof downloadBody.result?.download_url !== 'string'
    ) {
      return reply({
        connected: true,
        download_access: false,
        error: 'No download link was returned.'
      }, 502);
    }

    const dataset = body.result;
    const resources = Array.isArray(dataset.resources)
      ? dataset.resources
      : [];

    return reply({
      connected: true,
      download_access: true,
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
      note: 'Download-link access confirmed. No file downloaded and no database changed.'
    });
  } catch {
    return reply({
      connected: false,
      error: 'Connection test failed or timed out. No data was imported.'
    }, 502);
  }
};
