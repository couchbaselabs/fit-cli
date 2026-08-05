# fit-cli-role — the role fit-cli (human and CI) assumes for all its AWS/EC2/SSM
# work.

resource "aws_iam_role" "fit_cli_role" {
  name        = "fit-cli-role"
  path        = "/"
  description = "Managed by Terraform in couchbaselabs/fit-cli (terraform/fit-cli-role.tf) - don't edit directly in the console, changes will be overwritten."

  max_session_duration = 43200

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = "arn:aws:iam::958525475024:oidc-provider/token.actions.githubusercontent.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:couchbaselabs/fit-cli:*",
              "repo:couchbaselabs/transactions-fit-performer:*",
              "repo:couchbase/couchbase-jvm-clients:*",
              "repo:couchbase/couchbase-analytics-jvm-clients:*",
              "repo:couchbase/couchbase-cxx-client:*",
              "repo:couchbase/couchbase-net-client:*",
              "repo:couchbase/gocb:*",
              "repo:couchbase/couchnode:*",
              "repo:couchbase/couchbase-python-client:*",
              "repo:couchbase/couchbase-ruby-client:*",
              "repo:couchbase/couchbase-rs:*",
              "repo:couchbase/couchbase-php-client:*",
              "repo:couchbase/analytics-dotnet-client:*",
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Principal = {
          Federated = "arn:aws:iam::958525475024:oidc-provider/token.actions.githubusercontent.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud"   = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:actor" = "programmatix"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = "repo:programmatix/couchbase-jvm-clients:*"
          }
        }
      },
      {
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::958525475024:root"
        }
        Action = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy" "fit_cli_ec2_permissions" {
  name = "FitCliEc2PermissionsPolicy"
  role = aws_iam_role.fit_cli_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "FitCliEc2Permissions"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:DescribeImages",
          "ec2:DescribeVpcs",
          "ec2:RunInstances",
          "ec2:CreateKeyPair",
          "ec2:DescribeKeyPairs",
          "ec2:CreateTags",
          "ec2:TerminateInstances",
          "ec2:DescribeSecurityGroups",
          "ec2:CreateSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:DeleteKeyPair",
          "ec2:DeleteSecurityGroup",
          "ec2:DescribeVpcEndpoints",
          "ec2:CreateVpcEndpoint",
          "ec2:ModifyVpcEndpoint",
          "ec2:DeleteVpcEndpoints",
          "route53:AssociateVPCWithHostedZone",
          "ssm:SendCommand",
          "ssm:GetCommandInvocation",
          "ssm:DescribeInstanceInformation",
          "ssm:StartSession",
        ]
        Resource = "*"
      },
      {
        # Scoped to just the fit-cli/* secrets this role actually reads (github token,
        # gerrit ssh key, rosa creds, capella/results env creds - see environments.json5
        # and src/fit/util/config.ts). Secrets Manager appends a random suffix to ARNs,
        # hence the wildcard after the name prefix.
        Sid      = "FitCliSecretsPermissions"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:aws:secretsmanager:*:958525475024:secret:fit-cli/*"
      },
      {
        Sid    = "FitCliS3Permissions"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
        ]
        Resource = "arn:aws:s3:::fit-cli/*"
      },
      {
        # Needed so fit-cli can attach fit-cli-ssm-instance-role's instance profile when
        # launching EC2 instances (ec2:RunInstances with IamInstanceProfile).
        Sid      = "FitCliPassSsmInstanceRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.fit_cli_ssm_instance_role.arn
      },
      {
        # For ensureSsmLogGroup's self-provisioning (create/set retention) and SsmTarget's
        # reading of SendCommand output via CloudWatch Logs. Scoped to just the one log
        # group fit-cli uses for SSM command output.
        Sid    = "FitCliSsmOutputLogGroup"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:PutRetentionPolicy",
          "logs:FilterLogEvents",
          "logs:DeleteLogStream",
        ]
        Resource = "arn:aws:logs:*:958525475024:log-group:/fit-cli/ssm-command-output:*"
      },
      {
        # logs:DescribeLogGroups doesn't support resource-level restriction in IAM (AWS
        # always evaluates it against "*"), so it can't be scoped like the statement above.
        Sid      = "FitCliDescribeLogGroups"
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "*"
      },
    ]
  })
}
