import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation'
import {
  CacheBehaviors,
  CloudFrontClient,
  EventType,
  GetDistributionCommand,
  LambdaFunctionAssociations,
  UpdateDistributionCommand
} from '@aws-sdk/client-cloudfront'
import { LambdaClient, ListVersionsByFunctionCommand } from '@aws-sdk/client-lambda'
import type Serverless from 'serverless'
import type { Hooks, Logging } from 'serverless/classes/Plugin'
import type ServerlessPlugin from 'serverless/classes/Plugin'
import type AwsProvider from 'serverless/plugins/aws/provider/awsProvider'
import { setTimeout } from 'node:timers/promises'

interface PreExistingCloudFrontEvent extends AwsProvider.Event {
  preExistingCloudFront?: {
    distributionId: string
    eventType: EventType
    pathPattern: string
    includeBody: boolean
    stage?: string
  }
}

interface Association {
  preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront']
  functionArn: string
}

// CloudFront's write APIs have a low account-wide rate limit shared with every other deploy, and
// the SDK default (3 attempts, ~1s total delay) gives up before the limit resets.
const CLOUDFRONT_MAX_ATTEMPTS = 10

export default class ServerlessLambdaEdgePreExistingCloudFront implements ServerlessPlugin {
  public hooks: Hooks
  private readonly log: Logging['log']
  private readonly lambdaClient: LambdaClient
  private readonly cloudformationClient: CloudFormationClient
  private readonly cloudfrontClient: CloudFrontClient
  private readonly serverless: Serverless

  constructor(serverless: Serverless, options: Serverless.Options, logging: Logging) {
    this.serverless = serverless
    this.log = logging.log
    this.lambdaClient = new LambdaClient({
      region: this.region
    })
    this.cloudfrontClient = new CloudFrontClient({
      region: this.region,
      retryMode: 'adaptive',
      maxAttempts: CLOUDFRONT_MAX_ATTEMPTS
    })

    this.cloudformationClient = new CloudFormationClient({
      region: this.region
    })
    this.hooks = {
      'after:aws:deploy:finalize:cleanup': this.setupLambdaEdgePreExistingCloudFront.bind(this)
    }

    this.serverless.configSchemaHandler.defineCustomProperties({
      type: 'object',
      properties: {
        lambdaEdgePreExistingCloudFront: {
          type: 'object',
          properties: {
            validStages: {
              type: 'array',
              items: { type: 'string' },
              uniqueItems: true
            }
          }
        }
      }
    })

    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'preExistingCloudFront', {
      type: 'object',
      properties: {
        distributionId: {
          anyOf: [{ type: 'string' }, { type: 'object' }]
        },
        eventType: { type: 'string' },
        pathPattern: { type: 'string' },
        includeBody: { type: 'boolean' },
        stage: { type: 'string' }
      },
      required: ['distributionId', 'eventType', 'pathPattern', 'includeBody']
    })
  }

  get stage() {
    return this.serverless.getProvider('aws').getStage()
  }

  get region() {
    return this.serverless.service.provider.region
  }

  public async setupLambdaEdgePreExistingCloudFront() {
    const functions = this.serverless.service.getAllFunctions()
    const functionNames = functions.filter((functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName)
      return functionObj.events
    })

    const associationsByDistribution = new Map<string, Association[]>()
    for (const functionName of functionNames) {
      const functionObj = this.serverless.service.getFunction(functionName)
      const events: PreExistingCloudFrontEvent[] = functionObj.events.filter(
        (event: PreExistingCloudFrontEvent) =>
          event.preExistingCloudFront &&
          this.checkAllowedDeployStage() &&
          (event.preExistingCloudFront.stage === undefined ||
            event.preExistingCloudFront.stage == `${this.serverless.service.provider.stage}`)
      )
      if (events.length === 0) {
        continue
      }

      const functionArn = await this.getlatestVersionLambdaArn(functionObj.name)
      for (const event of events) {
        const resolvedDistributionId = await (event.preExistingCloudFront.distributionId[
          'Fn::ImportValue'
        ]
          ? this.resolveCfImportValue(event.preExistingCloudFront.distributionId['Fn::ImportValue'])
          : event.preExistingCloudFront.distributionId)
        this.log.notice(
          `${functionArn} (Event: ${event.preExistingCloudFront.eventType}, pathPattern: ${event.preExistingCloudFront.pathPattern}) is associating to ${resolvedDistributionId} CloudFront Distribution.`
        )

        const associations = associationsByDistribution.get(resolvedDistributionId) ?? []
        associations.push({ preExistingCloudFront: event.preExistingCloudFront, functionArn })
        associationsByDistribution.set(resolvedDistributionId, associations)
      }
    }

    for (const [distributionId, associations] of associationsByDistribution) {
      await this.updateDistribution(distributionId, associations)
    }
  }

  private async updateDistribution(
    resolvedDistributionId: string,
    associations: Association[],
    retryCount = 5
  ) {
    const config = await this.cloudfrontClient.send(
      new GetDistributionCommand({ Id: resolvedDistributionId })
    )
    const distributionConfig = config.Distribution.DistributionConfig

    let changed = false
    for (const { preExistingCloudFront, functionArn } of associations) {
      if (preExistingCloudFront.pathPattern === '*') {
        changed =
          this.associateFunction(
            distributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations,
            preExistingCloudFront,
            functionArn
          ) || changed
      } else {
        changed =
          this.associateNonDefaultCacheBehaviors(
            distributionConfig.CacheBehaviors,
            preExistingCloudFront,
            functionArn
          ) || changed
      }
    }

    if (!changed) {
      this.log.notice(
        `${resolvedDistributionId} CloudFront Distribution already has these associations, skipping update.`
      )
      return
    }

    await this.cloudfrontClient
      .send(
        new UpdateDistributionCommand({
          Id: resolvedDistributionId,
          IfMatch: config.ETag,
          DistributionConfig: distributionConfig
        })
      )
      .catch(async (error) => {
        if (error.name === 'PreconditionFailed' && retryCount > 0) {
          this.log.error(`received precondition failed error, retrying... (${retryCount}/5)`)
          retryCount -= 1

          await setTimeout(5000)
          return this.updateDistribution(resolvedDistributionId, associations, retryCount)
        }
        this.log.error(error)
        throw error
      })
  }

  private checkAllowedDeployStage() {
    if (this.serverless.service.custom?.lambdaEdgePreExistingCloudFront?.validStages) {
      return this.serverless.service.custom.lambdaEdgePreExistingCloudFront.validStages.includes(
        this.stage
      )
    }
    return true
  }

  private associateNonDefaultCacheBehaviors(
    cacheBehaviors: CacheBehaviors,
    preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront'],
    functionArn: string
  ) {
    let changed = false
    for (const cacheBehavior of cacheBehaviors.Items) {
      if (preExistingCloudFront.pathPattern === cacheBehavior.PathPattern) {
        changed =
          this.associateFunction(
            cacheBehavior.LambdaFunctionAssociations,
            preExistingCloudFront,
            functionArn
          ) || changed
      }
    }
    return changed
  }

  /**
   * Points the `eventType` association of `lambdaFunctionAssociations` at `functionArn`, in place.
   *
   * @returns whether the associations changed; false when that association was already in place.
   */
  private associateFunction(
    lambdaFunctionAssociations: LambdaFunctionAssociations,
    preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront'],
    functionArn: string
  ) {
    const items = lambdaFunctionAssociations.Items ?? []
    const existing = items.find((x) => x.EventType === preExistingCloudFront.eventType)
    if (
      existing?.LambdaFunctionARN === functionArn &&
      existing.IncludeBody === preExistingCloudFront.includeBody
    ) {
      return false
    }

    lambdaFunctionAssociations.Items = items.filter(
      (x) => x.EventType !== preExistingCloudFront.eventType
    )
    lambdaFunctionAssociations.Items.push({
      LambdaFunctionARN: functionArn,
      IncludeBody: preExistingCloudFront.includeBody,
      EventType: preExistingCloudFront.eventType
    })
    lambdaFunctionAssociations.Quantity = lambdaFunctionAssociations.Items.length
    return true
  }

  private async getlatestVersionLambdaArn(functionName: string, marker?: string) {
    const versions = await this.lambdaClient.send(
      new ListVersionsByFunctionCommand({
        FunctionName: functionName,
        MaxItems: 50,
        Marker: marker
      })
    )

    if (versions.NextMarker) {
      return await this.getlatestVersionLambdaArn(functionName, versions.NextMarker)
    }

    return versions.Versions.at(-1).FunctionArn
  }

  private async resolveCfImportValue(name: string, nextToken?: string) {
    const result = await this.cloudformationClient.send(
      new ListExportsCommand({ NextToken: nextToken })
    )

    const targetExportMeta = result.Exports.find((exportMeta) => exportMeta.Name === name)
    if (targetExportMeta) return targetExportMeta.Value
    if (result.NextToken) {
      return this.resolveCfImportValue(name, result.NextToken)
    }

    throw new Error(
      `Could not resolve Fn::ImportValue with name ${name}. Are you sure this value is exported ?`
    )
  }
}
