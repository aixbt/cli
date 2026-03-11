import type { Command } from 'commander'
import { getClientOptions } from '../lib/auth.js'
import { get } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { CliError } from '../lib/errors.js'

interface ClusterData {
  id: string
  name: string
  description: string
}

export function registerClustersCommand(program: Command): void {
  program
    .command('clusters')
    .description('Browse and inspect signal clusters')
    .action(async (_opts: unknown, cmd: Command) => {
      const { clientOpts, authMode, outputFormat } = getClientOptions(cmd)

      if (authMode.mode === 'pay-per-use') {
        throw new CliError(
          'Pay-per-use is not available for the clusters endpoint. Use an API key or --delayed.',
          'X402_NOT_AVAILABLE',
        )
      }

      const result = await output.withSpinner(
        'Fetching clusters...',
        outputFormat,
        () => get<ClusterData[]>('/v2/clusters', undefined, clientOpts),
        'Failed to fetch clusters',
        { silent: true },
      )

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured(result.data, outputFormat)
        return
      }

      output.cards(result.data.map((c) => ({
        title: c.name,
        fields: [
          { label: 'ID', value: c.id },
          { label: 'Description', value: c.description },
        ],
      })))

      if (result.data.length > 0) {
        console.log()
        output.dim(`${result.data.length} clusters`)
      }
    })
}
