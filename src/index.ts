import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { NotificationFunction } from './funcs/notification-function';

export interface NotificationsProperty {
  readonly emails?: string[];
}

export interface LambdaFunctionLogNotificationStackProps extends cdk.StackProps {
  readonly notifications: NotificationsProperty;
  //readonly logGroups: logs.ILogGroup[];
  readonly logGroupName: string;
}

export class LambdaFunctionLogNotificationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LambdaFunctionLogNotificationStackProps) {
    super(scope, id, props);

    const account = this.account;
    const region = this.region;

    const random = crypto.createHash('shake256', { outputLength: 4 })
      .update(cdk.Names.uniqueId(scope) + cdk.Names.uniqueId(this))
      .digest('hex');

    // SNSトピックの作成
    const topic: sns.Topic = new sns.Topic(this, 'LambdaFunctionLogNotificationTopic', {
      topicName: `lambda-func-log-notification-${random}-topic`,
      displayName: 'Lambda Function Log Notification Topic',
    });

    // Subscribe an email endpoint to the topic
    for (const email of props.notifications.emails ?? []) {
      topic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    const functionName = `lambda-func-log-subscription-${random}-func`;

    // 👇 notification Lambda Function
    const notificationFunction = new NotificationFunction(this, 'NotificationFunction', {
      functionName: functionName,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(3),
      role: new iam.Role(this, 'NotificationLambdaExecutionRole', {
        roleName: `lambda-log-notification-func-${random}-exec-role`,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
        inlinePolicies: {
          ['failure-destination-event-bridge-policy']: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['events:PutEvents'],
                resources: [`arn:aws:events:${region}:${account}:event-bus/default`],
              }),
            ],
          }),
        },
      }),
      logGroup: new logs.LogGroup(this, 'LogNotificationFunctionLogGroup', {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      }),
      logFormat: lambda.LogFormat.JSON,
      systemLogLevel: lambda.SystemLogLevel.INFO,
      applicationLogLevel: lambda.ApplicationLogLevel.INFO,
      onSuccess: new lambdaDestinations.EventBridgeDestination(),
      onFailure: new lambdaDestinations.EventBridgeDestination(),
    });

    // サブスクリプションフィルターの作成
    new logs.SubscriptionFilter(this, 'SubscriptionFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'LogGroup', props.logGroupName),
      destination: new logsDestinations.LambdaDestination(notificationFunction),
      filterPattern: logs.FilterPattern.literal('{ $.level = "ERROR" || $.level = "WARN" }'),
    });

    // Lambda Function Invocation Failure EventBridge Rule
    new events.Rule(this, 'LambdaFunctionLogSubscriptionFuncFailureRule', {
      ruleName: `lambda-func-log-subscription-${random}-func-failure-rule`,
      eventPattern: {
        source: ['lambda'],
        detailType: ['Lambda Function Invocation Result - Failure'],
        detail: {
          requestContext: {
            functionArn: [{
              wildcard: `${notificationFunction.functionArn}:*`,
            }],
          },
        },
      },
    });

    // Lambda Function Invocation Success EventBridge Rule
    new events.Rule(this, 'LambdaFunctionLogSubscriptionFuncSuccessRule', {
      ruleName: `lambda-func-log-subscription-${random}-func-success-rule`,
      eventPattern: {
        source: ['lambda'],
        detailType: ['Lambda Function Invocation Result - Success'],
        detail: {
          requestContext: {
            functionArn: [{
              wildcard: `${notificationFunction.functionArn}:*`,
            }],
          },
        },
      },
    });
  }
}
