import { RemovalPolicy, StackProps } from "aws-cdk-lib";
import {
  ISecurityGroup,
  InstanceClass,
  InstanceSize,
  InstanceType,
  Port,
  SecurityGroup,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
} from "aws-cdk-lib/aws-rds";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { SubnetNames } from "./networking";
import { RDSConfig } from "./config";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Function, Code, Runtime } from "aws-cdk-lib/aws-lambda";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";

export class DataBaseConstruct {
  sg: SecurityGroup;
  db_cluster: DatabaseCluster;

  constructor(
    scope: Construct,
    rds_config: RDSConfig,
    vpc: Vpc
  ) {
    const engine = DatabaseClusterEngine.auroraPostgres({
      version: AuroraPostgresEngineVersion.VER_13_7,
    });

    const db_name = "hyperswitch";

    const db_security_group = new SecurityGroup(scope, "Hyperswitch-SG", {
      securityGroupName: "Hyperswitch-SG",
      vpc: vpc,
    });

    this.sg = db_security_group;


    const secretName = 'hypers-db-master-user-secret';

    // Create the secret if it doesn't exist
    let secret= new Secret(scope, "hypers-db-master-user-secret", {
            secretName: secretName,
            description: "Database master user credentials",
            generateSecretString: {
              secretStringTemplate: JSON.stringify({ username: "db_user" }),
              generateStringKey: "password",
              passwordLength: 16,
              excludePunctuation: true,
            },
          });


    const db_cluster = new DatabaseCluster(
      scope,
      "hyperswitch-hyperswitch-cluster",
      {
        writer: ClusterInstance.provisioned("Writer Instance", {
          instanceType: InstanceType.of(
            rds_config.writer_instance_class,
            rds_config.writer_instance_size
          ),
        }),
        // readers: [
        //   ClusterInstance.provisioned("Reader Instance", {
        //     instanceType: InstanceType.of(
        //       rds_config.reader_instance_class,
        //       rds_config.reader_instance_size
        //     ),
        //   }),
        // ],
        vpc,
        vpcSubnets: { subnetGroupName: SubnetNames.PublicSubnet },
        engine,
        port: rds_config.port,
        securityGroups: [db_security_group],
        defaultDatabaseName: db_name,
        credentials: Credentials.fromSecret(secret),
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    // Add ingress rule to allow traffic from any IP address
    db_cluster.connections.allowFromAnyIpv4(Port.tcp(rds_config.port));

    this.db_cluster = db_cluster;

    let schemaBucket = new Bucket(scope, 'SchemaBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      bucketName: 'hyperswitch-schema-bucket',
    });


    const bucketDeployment = new BucketDeployment(scope, 'DeploySchemaToBucket', {
      sources: [Source.asset('./dependencies/schema')],
      destinationBucket: schemaBucket,
    });

    const lambdaRole = new Role(scope, 'RDSLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    schemaBucket.grantRead(lambdaRole, 'dependencies/schema.sql');

    lambdaRole.addToPolicy(
      new PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject'],
          resources: ['*', schemaBucket.bucketArn + '/*'],
      })
    );

    const lambdaSecurityGroup = new SecurityGroup(scope, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

  db_security_group.addIngressRule(lambdaSecurityGroup, Port.tcp(rds_config.port));

    const initializeDBFunction = new Function(scope, 'InitializeDBFunction', {
      runtime: Runtime.PYTHON_3_9,
      handler: 'index.handler',
      // code: Code.fromAsset('./dependencies/lambda_package/rds_lambda.py'),
      code: Code.fromAsset('./dependencies/lambda_package.zip'),
      environment: {
          DB_SECRET_ARN: secret.secretArn,
          SCHEMA_BUCKET: schemaBucket.bucketName,
          SCHEMA_FILE_KEY: './dependencies/schema.sql',
      },
      role: lambdaRole,
    });

  }

  addClient(
    peer: ISecurityGroup,
    port: number,
    description?: string,
    remote_rule?: boolean
  ) {
    this.sg.addIngressRule(peer, Port.tcp(port), description, remote_rule);
    peer.addEgressRule(this.sg, Port.tcp(port), description, remote_rule);
  }
}