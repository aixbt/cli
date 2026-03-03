import type { Command } from 'commander'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { CliError } from '../lib/errors.js'

// -- Response types --

interface ClusterData {
  id: string
  name: string
  description: string
}

// -- Table column definitions --

const CLUSTER_COLUMNS: output.TableColumn[] = [
  { key: 'name', header: 'Name', width: 22 },
  { key: 'description', header: 'Description', width: 50 },
  { key: 'id', header: 'ID', width: 26 },
]

// -- Command registration --

export function registerClustersCommand(program: Command): void {
  program
    .command('clusters')
    .description('Browse and inspect signal clusters')
    .action(async (_opts: unknown, cmd: Command) => {
      const { clientOpts, authMode, isJson } = getClientOptions(cmd)

      if (authMode.mode === 'pay-per-use') {
        throw new CliError(
          'Pay-per-use is not available for the clusters endpoint. Use an API key or --delayed.',
          'X402_NOT_AVAILABLE',
        )
      }

      const result = await output.withSpinner(
        'Fetching clusters...',
        isJson,
        () => get<ClusterData[]>('/v2/clusters', undefined, clientOpts),
        'Failed to fetch clusters',
      )

      if (isJson) {
        output.json(result.data)
        return
      }

      const rows = result.data.map((c) => ({
        name: c.name,
        description: c.description,
        id: c.id,
      }))

      output.table(rows, CLUSTER_COLUMNS)
      console.log()
      output.dim(`${result.data.length} clusters`)
    })
}
