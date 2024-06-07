import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { LambdaFunctionLogNotificationStack } from '../src';

test('hello', () => {
  const app = new App();

  const stack = new LambdaFunctionLogNotificationStack(app, 'LambdaFunctionLogNotificationStack', {
    notifications: {
      emails: [
        'foo@example.com',
      ],
    },
    logGroupName: 'example-function-log',
  });

  const template = Template.fromStack(stack);

  expect(template.toJSON()).toMatchSnapshot();
});