# This is the role/profile EC2 instances
# fit-cli launches need attached so their SSM Agent can register and run
# commands; separate from fit-cli-role, which is what the caller (human/CI)
# assumes to send those commands.
# We need this to enable SSM on the instance.  After that we assume fit-cli-role
# and that takes care of remaining permissions.

resource "aws_iam_role" "fit_cli_ssm_instance_role" {
  name = "fit-cli-ssm-instance-role"
  path = "/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "fit_cli_ssm_instance_core" {
  role       = aws_iam_role.fit_cli_ssm_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# SendCommand's inline stdout/stderr is capped at ~24000 characters, so ssm-target.ts
# sends every command with CloudWatchOutputConfig and reads the real output back from
# this log group. It's the SSM Agent on the instance - not the caller - that writes
# those streams, so the permission has to live here. AmazonSSMManagedInstanceCore
# does not include CloudWatch Logs write access. Without this the log group stays
# empty and every capture silently degrades to the truncated inline content.
resource "aws_iam_role_policy" "fit_cli_ssm_instance_command_output" {
  name = "FitCliSsmCommandOutputPolicy"
  role = aws_iam_role.fit_cli_ssm_instance_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "FitCliSsmCommandOutputLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ]
        Resource = "arn:aws:logs:*:958525475024:log-group:/fit-cli/ssm-command-output:*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "fit_cli_ssm_instance_profile" {
  name = "fit-cli-ssm-instance-role"
  role = aws_iam_role.fit_cli_ssm_instance_role.name
}
