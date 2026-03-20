import type { Command } from 'commander'
import { getPublicClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'

interface ClusterData {
  id: string
  name: string
  description: string
}

export function registerClustersCommand(program: Command): void {
  program
    .command('clusters')
    .description('Explore signal clusters')
    .action(async (_opts: unknown, cmd: Command) => {
      // Clusters is a reference endpoint — always returns current data, no auth required.
      const { clientOpts, outputFormat, verbosity } = getPublicClientOptions(cmd)

      const result = await output.withSpinner(
        'Fetching clusters...',
        outputFormat,
        () => get<ClusterData[]>('/v2/clusters', undefined, clientOpts),
        'Failed to fetch clusters',
        { silent: true },
      )

      if (output.isStructuredFormat(outputFormat)) {
        output.outputApiResult({ data: result.data, meta: result.meta }, outputFormat)
        return
      }

      output.cards(result.data.map((c) => ({
        title: c.name,
        fields: [
          { label: 'ID', value: output.fmt.id(c.id) },
          ...(verbosity >= 1 ? [{ label: 'Description', value: c.description }] : []),
        ],
      })))

      if (result.data.length > 0) {
        console.log()
        output.dim(`${result.data.length} clusters`)
      }

    })
}
