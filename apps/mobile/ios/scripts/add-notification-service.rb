# Adds the "NotificationService" app extension target (decrypts push payloads on the device,
# docs/v2/05-native.md §5) to ios/App/App.xcodeproj. Idempotent: does nothing if the target exists.
#
# There is no Mac in the project yet, so the target is created by this script instead of by Xcode:
#   - CI (.github/workflows/ios.yml) runs it before every build;
#   - the first time someone builds on a Mac, run it once and commit the changed project.pbxproj:
#       gem install xcodeproj && ruby apps/mobile/ios/scripts/add-notification-service.rb
require 'xcodeproj'

root = File.expand_path('../App', __dir__)
project_path = File.join(root, 'App.xcodeproj')
project = Xcodeproj::Project.open(project_path)

if project.targets.any? { |t| t.name == 'NotificationService' }
  puts 'NotificationService target already present'
  exit 0
end

app = project.targets.find { |t| t.name == 'App' } or abort('App target not found')
ext = project.new_target(:app_extension, 'NotificationService', :ios, '16.0')

group = project.main_group.find_subpath('NotificationService', true)
group.set_source_tree('<group>')
group.set_path('NotificationService')
service_ref = group.new_reference('NotificationService.swift')
group.new_reference('Info.plist')
group.new_reference('NotificationService.entitlements')

shared_ref = project.main_group.find_subpath('App', false).files.find { |f| f.path == 'KithwallShared.swift' } or abort('KithwallShared.swift not in the App group')
ext.add_file_references([service_ref, shared_ref])
ext.add_system_framework('UserNotifications')

ext.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.kithwall.app.NotificationService'
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['INFOPLIST_FILE'] = 'NotificationService/Info.plist'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['CODE_SIGN_ENTITLEMENTS'] = 'NotificationService/NotificationService.entitlements'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['SWIFT_VERSION'] = '5.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  s['MARKETING_VERSION'] = '1.0'
  s['CURRENT_PROJECT_VERSION'] = '1'
  s['SKIP_INSTALL'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
end

# Build the extension with the app and embed it in App.app/PlugIns.
app.add_dependency(ext)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
build_file = embed.add_file_reference(ext.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts 'NotificationService target added'
