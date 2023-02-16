/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import {
  CustomizationsConfig,
  Ec2FirewallAutoScalingGroupConfig,
  Ec2FirewallInstanceConfig,
  TargetGroupItemConfig,
} from '../../lib/customizations-config';
import { NetworkConfig, GwlbConfig, VpcConfig, VpcTemplatesConfig, SubnetConfig } from '../../lib/network-config';
import { NetworkValidatorFunctions } from './network-validator-functions';

/**
 * Class to validate Gateway LoadBalancers
 */
export class GatewayLoadBalancersValidator {
  constructor(values: NetworkConfig, configDir: string, helpers: NetworkValidatorFunctions, errors: string[]) {
    //
    // Validate gateway load balancers deployment account names
    //
    this.validateGwlbDeploymentTargetAccounts(values, helpers, errors);

    //
    // Validate GWLB configuration
    //
    this.validateGwlbConfiguration(values, configDir, helpers, errors);
  }

  /**
   * Function to validate existence of GWLB deployment target accounts
   * Make sure deployment target accounts are part of account config file
   * @param values
   * @param helpers
   * @param errors
   */
  private validateGwlbDeploymentTargetAccounts(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const gwlb of values.centralNetworkServices?.gatewayLoadBalancers ?? []) {
      for (const endpoint of gwlb.endpoints ?? []) {
        if (!helpers.accountExists(endpoint.account)) {
          errors.push(
            `Deployment target account ${endpoint.account} for Gateway Load Balancer ${gwlb.name} endpoint ${endpoint.name} does not exist in accounts-config.yaml file.`,
          );
        }
      }
    }
  }

  /**
   * Validate Gateway Load Balancer endpoint configuration
   * @param gwlb
   * @param helpers
   * @param values
   */
  private validateGwlbEndpoints(gwlb: GwlbConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    for (const gwlbEndpoint of gwlb.endpoints ?? []) {
      const vpc = helpers.getVpc(gwlbEndpoint.vpc);
      if (!vpc) {
        errors.push(
          `[Gateway Load Balancer ${gwlb.name} endpoint ${gwlbEndpoint.name}]: VPC ${gwlbEndpoint.vpc} does not exist`,
        );
      }

      // Validate subnet
      if (vpc && !helpers.getSubnet(vpc, gwlbEndpoint.subnet)) {
        errors.push(
          `[Gateway Load Balancer ${gwlb.name} endpoint ${gwlbEndpoint.name}]: subnet ${gwlbEndpoint.subnet} does not exist in VPC ${vpc.name}`,
        );
      }
    }
  }

  /**
   * Validate Gateway Load Balancer configuration
   * @param values
   */
  private validateGwlbConfiguration(
    values: NetworkConfig,
    configDir: string,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const gwlb of values.centralNetworkServices?.gatewayLoadBalancers ?? []) {
      const vpc = helpers.getVpc(gwlb.vpc);
      if (!vpc) {
        errors.push(`[Gateway Load Balancer ${gwlb.name}]: VPC ${gwlb.vpc} does not exist`);
      }

      // Validate subnets
      if (vpc) {
        this.validateGwlbSubnets(gwlb, vpc, helpers, errors);
      }
      // Validate endpoints
      this.validateGwlbEndpoints(gwlb, helpers, errors);
      // Validate target groups
      if (gwlb.targetGroup) {
        this.validateGwlbTargetGroup(gwlb, configDir, errors);
      }
    }
  }

  /**
   * Validate GWLB subnets
   * @param gwlb
   * @param vpc
   * @param helpers
   * @param errors
   */
  private validateGwlbSubnets(
    gwlb: GwlbConfig,
    vpc: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate subnets exist in VPC
    const validSubnets: SubnetConfig[] = [];
    for (const gwlbSubnet of gwlb.subnets ?? []) {
      const subnet = helpers.getSubnet(vpc, gwlbSubnet);
      if (!subnet) {
        errors.push(`[Gateway Load Balancer ${gwlb.name}]: subnet ${gwlbSubnet} does not exist in VPC ${vpc.name}`);
      }
      if (subnet) {
        validSubnets.push(subnet);
      }
    }

    // Validate subnets are in different AZs
    if (validSubnets.length === gwlb.subnets.length) {
      const azs = validSubnets.map(item => {
        return item.availabilityZone;
      });

      if (helpers.hasDuplicates(azs)) {
        errors.push(
          `[Gateway Load Balancer ${gwlb.name}]: targeted subnets reside in duplicate availability zones. Please target unique AZs. AZs targeted: ${azs}`,
        );
      }
    }
  }

  /**
   * Validate Gateway Load Balancer target group
   * @param gwlb
   * @param configDir
   * @param errors
   */
  private validateGwlbTargetGroup(gwlb: GwlbConfig, configDir: string, errors: string[]) {
    // Pull values from customizations config
    const customizationsConfig = CustomizationsConfig.load(configDir);
    const firewallInstances = customizationsConfig.firewalls?.instances;
    const autoscalingGroups = customizationsConfig.firewalls?.autoscalingGroups;
    const targetGroups = customizationsConfig.firewalls?.targetGroups;

    if (!targetGroups) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name}]: target group ${gwlb.targetGroup} not found in customizations-config.yaml`,
      );
    }

    const targetGroup = targetGroups!.find(group => group.name === gwlb.targetGroup);

    if (!targetGroup) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name}]: target group ${gwlb.targetGroup} not found in customizations-config.yaml`,
      );
    }

    if (targetGroup) {
      this.validateTargetGroupProps(gwlb, targetGroup, errors);
    }

    if (targetGroup && targetGroup.targets) {
      this.validateTargetGroupTargets(gwlb, targetGroup, firewallInstances!, errors);
    }

    if (targetGroup && !targetGroup.targets) {
      this.validateTargetGroupAsg(gwlb, targetGroup, autoscalingGroups!, errors);
    }
  }

  /**
   * Validate target group properties
   * @param gwlb
   * @param targetGroup
   * @param errors
   */
  private validateTargetGroupProps(gwlb: GwlbConfig, targetGroup: TargetGroupItemConfig, errors: string[]) {
    if (targetGroup.port !== 6081) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: only port 6081 is supported.`,
      );
    }
    if (targetGroup.protocol !== 'GENEVE') {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: only GENEVE protocol is supported.`,
      );
    }
  }

  /**
   * Validate firewall instances and GWLB reside in the same VPC
   * @param gwlb
   * @param targetGroup
   * @param firewallInstances
   * @param errors
   */
  private validateTargetGroupTargets(
    gwlb: GwlbConfig,
    targetGroup: TargetGroupItemConfig,
    firewallInstances: Ec2FirewallInstanceConfig[],
    errors: string[],
  ) {
    // Instance VPCs are validated in customizations config. We just need to grab the first element
    const firewall = firewallInstances.find(instance => instance.name === targetGroup.targets![0]);

    if (!firewall) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: firewall instance ${
          targetGroup.targets![0]
        } not found in customizations-config.yaml`,
      );
    }

    if (firewall && firewall.vpc !== gwlb.vpc) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: targets do not exist in the same VPC as the load balancer`,
      );
    }
  }

  /**
   * Validate ASG and GWLB reside in the same VPC
   * @param gwlb
   * @param targetGroup
   * @param autoscalingGroups
   * @param errors
   */
  private validateTargetGroupAsg(
    gwlb: GwlbConfig,
    targetGroup: TargetGroupItemConfig,
    autoscalingGroups: Ec2FirewallAutoScalingGroupConfig[],
    errors: string[],
  ) {
    const asg = autoscalingGroups.find(
      group => group.autoscaling.targetGroups && group.autoscaling.targetGroups[0] === targetGroup.name,
    );

    if (!asg) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: firewall ASG for target group not found in customizations-config.yaml`,
      );
    }

    if (asg && asg.vpc !== gwlb.vpc) {
      errors.push(
        `[Gateway Load Balancer ${gwlb.name} target group ${targetGroup.name}]: targets do not exist in the same VPC as the load balancer`,
      );
    }
  }
}
