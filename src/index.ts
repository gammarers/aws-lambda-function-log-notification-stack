import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
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

    // 👇 notification Lambda Function
    const notificationFunction = new NotificationFunction(this, 'NotificationFunction', {
      functionName: `lambda-function-log-notification-${random}-func`,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(3),
      role: new iam.Role(this, 'NotificationLambdaExecutionRole', {
        roleName: `lambda-log-notification-func-${random}-exec-role`,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      }),
      logGroup: new logs.LogGroup(this, 'NotificationFunctionLogGroup', {
        // logGroupName: lambdaFunction.logGroup.logGroupName,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      }),
      logFormat: lambda.LogFormat.JSON,
      systemLogLevel: lambda.SystemLogLevel.INFO,
      applicationLogLevel: lambda.ApplicationLogLevel.INFO,
    });

    // サブスクリプションフィルターの作成
    new logs.SubscriptionFilter(this, 'SubscriptionFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'LogGroup', props.logGroupName),
      destination: new destinations.LambdaDestination(notificationFunction),
      filterPattern: logs.FilterPattern.literal('{ $.level = "ERROR" || $.level = "WARN" }'),
    });
  }
}
