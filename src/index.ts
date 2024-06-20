import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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
    new cdk.CfnOutput(this, 'OutPutLogNotificationFunctionName', {
      key: 'LogNotificationFunctionName',
      value: notificationFunction.functionName,
      exportName: 'LogNotificationFunctionName',
    });

    // stepfunction
    // Prepare Message
    const prepareMessage: sfn.Pass = new sfn.Pass(this, 'PrepareMessage', {
      parameters: {
        Subject: sfn.JsonPath.format('😵[Failure] AWS Lambda Function Invocation Error Log Found [{}][{}]',
          sfn.JsonPath.stringAt('$.account'),
          sfn.JsonPath.stringAt('$.region'),
        ),
        Message: sfn.JsonPath.format('Account : {}\nRegion : {}\nLogGroup : {}\nLogStream : {}\nTimestamp : {}\nRequestId : {}\nErrorType : {}\nErrorMessage : {}\nStackTrace : \n{}',
          sfn.JsonPath.stringAt('$.account'),
          sfn.JsonPath.stringAt('$.region'),
          sfn.JsonPath.stringAt('$.detail.responsePayload.logGroup'),
          sfn.JsonPath.stringAt('$.detail.responsePayload.logStream'),
          sfn.JsonPath.stringAt('$.Temp.Log.Parsed.timestamp'),
          sfn.JsonPath.stringAt('$.Temp.Log.Parsed.requestId'),
          sfn.JsonPath.stringAt('$.Temp.Log.Parsed.message.errorType'),
          sfn.JsonPath.stringAt('$.Temp.Log.Parsed.message.errorMessage'),
          sfn.JsonPath.stringAt('$.Prepare.Concatenated.StackTrace'),
        ),
      },
      resultPath: '$.Prepare.Sns.Topic',
    });

    const init: sfn.Pass = new sfn.Pass(this, 'Init', {
      result: sfn.Result.fromString(''),
      resultPath: '$.Prepare.Concatenated.StackTrace',
    });

    // ----
    // Get Log Events
    const getLogEvents = new sfn.Pass(this, 'GetLogEvents', {
      parameters: {
        Events: sfn.JsonPath.stringAt('$.detail.responsePayload.logEvents'),
      },
      resultPath: '$.Temp.Log',
    });

    init.next(getLogEvents);

    const getLogEventDetail = new sfn.Pass(this, 'GetLogEventDetail', {
      parameters: {
        Detail: sfn.JsonPath.arrayGetItem(sfn.JsonPath.stringAt('$.Temp.Log.Events'), 0),
      },
      resultPath: '$.Temp.Log.Event',
    });

    const checkUntreatedLogEventDetailExist: sfn.Choice = new sfn.Choice(this, 'CheckUntreatedLogEventDetailExist')
      .when(sfn.Condition.isPresent('$.Temp.Log.Events[0]'), getLogEventDetail)
      .otherwise(new sfn.Succeed(this, 'Succeed'));

    getLogEvents.next(checkUntreatedLogEventDetailExist);


    // String to json
    const getLogEventMessage: sfn.Pass = new sfn.Pass(this, 'GetLogEventMessage', {
      parameters: {
        Parsed: sfn.JsonPath.stringToJson(sfn.JsonPath.stringAt('$.Temp.Log.Event.Detail.message')),
      },
      resultPath: '$.Temp.Log',
    });

    getLogEventDetail.next(getLogEventMessage);

    // String to json
    const getLogEventMessageStackTrace: sfn.Pass = new sfn.Pass(this, 'GetLogEventMessageStackTrace', {
      parameters: {
        Lines: sfn.JsonPath.stringAt('$.Temp.Log.Parsed.message.stackTrace'),
      },
      resultPath: '$.Temp.StackTrace',
    });

    getLogEventMessage.next(getLogEventMessageStackTrace);

    const getLogEventMessageStackTraceLine = new sfn.Pass(this, 'GetLogEventMessageStackTraceLine', {
      parameters: {
        Line: sfn.JsonPath.arrayGetItem(sfn.JsonPath.stringAt('$.Temp.StackTrace.Lines'), 0),
      },
      resultPath: '$.Temp.GetStackTrace',
    });

    const checkUntreatedMessageStackTraceLinesExist: sfn.Choice = new sfn.Choice(this, 'CheckUntreatedMessageStackTraceLinesExist')
      .when(sfn.Condition.isPresent('$.Temp.StackTrace.Lines[0]'), getLogEventMessageStackTraceLine)
      .otherwise(prepareMessage);

    getLogEventMessageStackTrace.next(checkUntreatedMessageStackTraceLinesExist);

    const concatenateStackTraceLine: sfn.Pass = new sfn.Pass(this, 'ConcatenateStackTraceLine', {
      parameters: {
        StackTrace: sfn.JsonPath.format('{}{}\n', sfn.JsonPath.stringAt('$.Prepare.Concatenated.StackTrace'), sfn.JsonPath.stringAt('$.Temp.GetStackTrace.Line')),
      },
      resultPath: '$.Prepare.Concatenated',
    });

    getLogEventMessageStackTraceLine.next(concatenateStackTraceLine);

    const getUntreatedMessageTraceLines: sfn.Pass = new sfn.Pass(this, 'UntreatedMessageTraceLines', {
      parameters: {
        Lines: sfn.JsonPath.stringAt('$.Temp.StackTrace.Lines[1:]'),
      },
      resultPath: '$.Temp.StackTrace',
    });

    concatenateStackTraceLine.next(getUntreatedMessageTraceLines);
    getUntreatedMessageTraceLines.next(checkUntreatedMessageStackTraceLinesExist);

    const sendNotification: tasks.SnsPublish = new tasks.SnsPublish(this, 'SendNotification', {
      topic: topic,
      inputPath: '$.Prepare.Sns.Topic',
      subject: sfn.JsonPath.stringAt('$.Subject'),
      message: sfn.TaskInput.fromJsonPathAt('$.Message'),
      resultPath: '$.Result.Sns.Topic',
    });

    prepareMessage.next(sendNotification);

    const getUntreatedMessages: sfn.Pass = new sfn.Pass(this, 'GetUntreatedMessages', {
      parameters: {
        Lines: sfn.JsonPath.stringAt('$.TempStackTrace.Lines[1:]'),
      },
      resultPath: '$.TempStackTrace',
    });

    getUntreatedMessages.next(checkUntreatedLogEventDetailExist);

    sendNotification.next(getUntreatedMessages);

    // Step Functions State Machine
    const stateMachine: sfn.StateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: `lambda-func-log-subscription-notification-${random}-state-machine`,
      timeout: cdk.Duration.minutes(5),
      definitionBody: sfn.DefinitionBody.fromChainable(init),
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
      targets: [
        new targets.SfnStateMachine(stateMachine, {
          role: new iam.Role(this, 'StartExecMachineRole', {
            roleName: `log-notification-start-exec-machine-${random}-role`,
            description: 'lambda func log subscription notification start exec machine (send notification).',
            assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
            inlinePolicies: {
              'states-start-execution-policy': new iam.PolicyDocument({
                statements: [
                  new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                      'states:StartExecution',
                    ],
                    resources: ['*'],
                  }),
                ],
              }),
            },
          }),
        }),
      ],
    });
  }
}
