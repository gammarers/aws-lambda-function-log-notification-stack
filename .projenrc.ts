import { awscdk } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'yicr',
  authorAddress: 'yicr@users.noreply.github.com',
  authorOrganization: true,
  cdkVersion: '2.120.0',
  defaultReleaseBranch: 'main',
  typescriptVersion: '5.3.x',
  jsiiVersion: '5.3.x',
  name: '@gammarers/aws-lambda-function-log-notification-stack',
  projenrcTs: true,
  repositoryUrl: 'https://github.com/gammarers/aws-lambda-function-log-notification-stack.git',
  releaseToNpm: false, // temporary
  depsUpgrade: false, // temporary
  devDeps: [
    '@types/aws-lambda@^8.10.136',
  ],
  minNodeVersion: '18.0.0',
  workflowNodeVersion: '22.2.0',
});
project.synth();